package store

import (
	"time"

	"folder-sync/internal/s3"
)

// Objects is the engine's own object calls (docs/peps/0007 §3.1, 0009 §4): the few things rclone cannot do. A manifest
// read with a conditional GET, a server-side copy conditioned on the source, a create-once PUT, a delimiter listing.
// rclone moves every file; these move manifests, history and requests.
//
// The bucket argument is the Spec's Bucket. A file store ignores it (it knows its directory); an S3 store addresses
// "<endpoint>/<bucket>/<key>". Errors are the s3 package's: s3.ErrNotFound and s3.ErrPreconditionFailed match with
// errors.Is whatever the store.
type Objects interface {
	HeadBucket(bucket string) error
	ListOne(bucket, prefix string) error
	Head(bucket, key string) (etag string, found bool, err error)
	GetIfNoneMatch(bucket, key, etag string) (s3.GetResult, error)
	Copy(bucket, srcKey, dstKey, ifMatch string) error
	Delete(bucket, key string) error
	Put(bucket, key string, body []byte, contentType, ifNoneMatch, ifMatch string) (string, error)
	PutFile(bucket, key string, body []byte, mtime time.Time) (string, error)
	List(bucket, prefix, delimiter string) (s3.ListResult, error)
	HeadObject(bucket, key string) (s3.Stat, error)
	GetToFile(bucket, key, path string) error
	GetRangeToFile(bucket, key, path string, from, to int64, ifMatch string) error
}

// *s3.Client is the S3 implementation: AWS, R2, B2, Wasabi, MinIO and Google's interoperability API all answer it.
var _ Objects = (*s3.Client)(nil)
