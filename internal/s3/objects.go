package s3

// The object calls PEP 0007's history needs (docs/peps/0007 §3.1): a server-side copy conditioned on the source being
// the version the manifest lists, a delete, a conditional PUT for change records and restore requests, a delimiter
// listing, and a GET into a file. WHY native calls and not rclone: rclone's --backup-dir can only append to a name, so
// it cannot put a version under its path, and it has no conditional copy.

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// ErrPreconditionFailed matches (errors.Is) a 412: an If-Match, If-None-Match or x-amz-copy-source-if-match that did
// not hold.
var ErrPreconditionFailed = errors.New("precondition failed (412)")

// ErrNotFound matches (errors.Is) a 404 from a call that needs the object (a copy's source, a GET into a file).
var ErrNotFound = errors.New("no such object (404)")

func (c *Client) do(req *http.Request, payloadHash string) (*http.Response, error) {
	SignWithToken(req, c.AccessKeyID, c.SecretAccessKey, c.SessionToken, c.Region, c.now(), payloadHash)
	return c.httpClient().Do(req)
}

// statusError is a non-2xx answer as an error, with the start of its body (S3's XML error says why).
func statusError(what string, resp *http.Response) error {
	snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	switch resp.StatusCode {
	case http.StatusPreconditionFailed:
		return fmt.Errorf("%s: %w", what, ErrPreconditionFailed)
	case http.StatusNotFound:
		return fmt.Errorf("%s: %w", what, ErrNotFound)
	}
	return fmt.Errorf("%s returned %s: %s", what, resp.Status, strings.TrimSpace(string(snippet)))
}

// Copy copies srcKey to dstKey inside bucket, server side, with no custom metadata on the copy (a kept version is its
// bytes and nothing else: docs/CONTRACT.md "Deletions and history"). A non-empty ifMatch (an ETag, quoted or not) is
// sent as x-amz-copy-source-if-match: a source that is not that version answers ErrPreconditionFailed, and nothing is
// written. A missing source answers ErrNotFound. Single-part only: up to 5 GiB.
func (c *Client) Copy(bucket, srcKey, dstKey, ifMatch string) error {
	req, err := c.newRequest(http.MethodPut, bucket, dstKey)
	if err != nil {
		return err
	}
	req.Header.Set("x-amz-copy-source", "/"+uriEncode(bucket)+"/"+EncodePath(srcKey))
	req.Header.Set("x-amz-metadata-directive", "REPLACE")
	if ifMatch != "" {
		req.Header.Set("x-amz-copy-source-if-match", quote(ifMatch))
	}
	resp, err := c.do(req, EmptySHA256)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return statusError("COPY "+srcKey, resp)
	}
	// WHY read the body: S3 may answer 200 and put the error in it (a copy that failed after it started).
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if bytes.Contains(body, []byte("<Error>")) {
		return fmt.Errorf("COPY %s: %s", srcKey, strings.TrimSpace(string(body)))
	}
	return nil
}

// Delete removes one object. A key that is already gone is not an error (deleting a deleted key is a no-op).
func (c *Client) Delete(bucket, key string) error {
	req, err := c.newRequest(http.MethodDelete, bucket, key)
	if err != nil {
		return err
	}
	resp, err := c.do(req, EmptySHA256)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK, http.StatusNoContent, http.StatusNotFound:
		return nil
	}
	return statusError("DELETE "+key, resp)
}

// Put writes body to key. ifNoneMatch "*" creates it only if absent; a non-empty ifMatch overwrites only that ETag.
// Either refusal is ErrPreconditionFailed. It answers the new object's ETag as the store sent it.
func (c *Client) Put(bucket, key string, body []byte, contentType, ifNoneMatch, ifMatch string) (string, error) {
	req, err := c.newRequest(http.MethodPut, bucket, key)
	if err != nil {
		return "", err
	}
	req.Body = io.NopCloser(bytes.NewReader(body))
	req.ContentLength = int64(len(body))
	req.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if ifNoneMatch != "" {
		req.Header.Set("If-None-Match", ifNoneMatch)
	}
	if ifMatch != "" {
		req.Header.Set("If-Match", quote(ifMatch))
	}
	resp, err := c.do(req, sha256Hex(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", statusError("PUT "+key, resp)
	}
	return resp.Header.Get("ETag"), nil
}

// Object is one listed object.
type Object struct {
	Key          string
	LastModified time.Time
	ETag         string // as listed, quoted
	Size         int64
}

// ListResult is one or more pages of a ListObjectsV2.
type ListResult struct {
	Objects  []Object
	Prefixes []string // common prefixes, with a delimiter
}

type listPage struct {
	Contents []struct {
		Key          string `xml:"Key"`
		LastModified string `xml:"LastModified"`
		ETag         string `xml:"ETag"`
		Size         int64  `xml:"Size"`
	} `xml:"Contents"`
	CommonPrefixes []struct {
		Prefix string `xml:"Prefix"`
	} `xml:"CommonPrefixes"`
	IsTruncated           bool   `xml:"IsTruncated"`
	NextContinuationToken string `xml:"NextContinuationToken"`
}

// List lists every key under prefix (one ListObjectsV2 request per 1,000 keys). A non-empty delimiter groups deeper
// keys into Prefixes, as a folder listing does.
func (c *Client) List(bucket, prefix, delimiter string) (ListResult, error) {
	var out ListResult
	token := ""
	for {
		req, err := c.newRequest(http.MethodGet, bucket, "")
		if err != nil {
			return out, err
		}
		query := url.Values{}
		query.Set("list-type", "2")
		query.Set("prefix", prefix)
		if delimiter != "" {
			query.Set("delimiter", delimiter)
		}
		if token != "" {
			query.Set("continuation-token", token)
		}
		// WHY %20 and not +: the signature's canonical query encodes a space as %20 (uriEncode), and the
		// server reads the query it was sent.
		req.URL.RawQuery = strings.ReplaceAll(query.Encode(), "+", "%20")
		resp, err := c.do(req, EmptySHA256)
		if err != nil {
			return out, err
		}
		if resp.StatusCode != http.StatusOK {
			err := statusError("LIST "+prefix, resp)
			resp.Body.Close()
			return out, err
		}
		var page listPage
		err = xml.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&page)
		resp.Body.Close()
		if err != nil {
			return out, fmt.Errorf("LIST %s: %w", prefix, err)
		}
		for _, item := range page.Contents {
			modified, err := time.Parse(time.RFC3339Nano, item.LastModified)
			if err != nil {
				return out, fmt.Errorf("LIST %s: %s: LastModified %q: %w", prefix, item.Key, item.LastModified, err)
			}
			out.Objects = append(out.Objects, Object{Key: item.Key, LastModified: modified.UTC(), ETag: item.ETag, Size: item.Size})
		}
		for _, p := range page.CommonPrefixes {
			out.Prefixes = append(out.Prefixes, p.Prefix)
		}
		if !page.IsTruncated || page.NextContinuationToken == "" {
			return out, nil
		}
		token = page.NextContinuationToken
	}
}

// Stat is a HEAD's answer about one object.
type Stat struct {
	ETag         string // quoted, as sent
	LastModified time.Time
	Size         int64
}

// HeadObject answers an object's ETag, Last-Modified (to the second: an HTTP date) and size; ErrNotFound when absent.
func (c *Client) HeadObject(bucket, key string) (Stat, error) {
	req, err := c.newRequest(http.MethodHead, bucket, key)
	if err != nil {
		return Stat{}, err
	}
	resp, err := c.do(req, EmptySHA256)
	if err != nil {
		return Stat{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Stat{}, statusError("HEAD "+key, resp)
	}
	modified, _ := http.ParseTime(resp.Header.Get("Last-Modified"))
	size, _ := strconv.ParseInt(resp.Header.Get("Content-Length"), 10, 64)
	return Stat{ETag: resp.Header.Get("ETag"), LastModified: modified.UTC(), Size: size}, nil
}

// GetToFile streams an object into path (created or truncated); ErrNotFound when absent.
func (c *Client) GetToFile(bucket, key, path string) error {
	req, err := c.newRequest(http.MethodGet, bucket, key)
	if err != nil {
		return err
	}
	// WHY no client timeout here: a large version takes longer than the 60 s that bounds a manifest GET.
	client := c.HTTP
	if client == nil {
		client = &http.Client{}
	}
	SignWithToken(req, c.AccessKeyID, c.SecretAccessKey, c.SessionToken, c.Region, c.now(), EmptySHA256)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return statusError("GET "+key, resp)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func quote(etag string) string {
	if strings.HasPrefix(etag, `"`) {
		return etag
	}
	return `"` + etag + `"`
}
