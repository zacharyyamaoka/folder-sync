"""List and read a folder-sync project from its bucket, using only manifests and GETs.

The reference reader for docs/CONTRACT.md. Standard library only: it signs its
own S3 requests (SigV4 over urllib). If boto3 is installed, ``Boto3Store`` wraps
a boto3 client instead; nothing else changes.

    from folder_sync_read import Project, StdlibStore
    store = StdlibStore(endpoint, access_key_id, secret_access_key, bucket="folder-sync")
    project = Project(store, "demo")                          # folder-sync v0: keys start at the project
    mine = Project(store, "demo", root="users/AbC123/")      # an account root: every key starts with it
    for ref in project.files():
        print(ref.host_name, ref.path, ref.size)
    data = project.read(ref.host_id, ref.path)

Command line (the key comes from FOLDER_SYNC_ACCESS_KEY_ID / FOLDER_SYNC_SECRET_ACCESS_KEY,
the endpoint from FOLDER_SYNC_ENDPOINT or FOLDER_SYNC_ACCOUNT_ID):

    python3 folder_sync_read.py --bucket folder-sync --project demo list
    python3 folder_sync_read.py --bucket folder-sync --project demo cat <host-id> notes/plan.md
    python3 folder_sync_read.py --bucket folder-sync --root users/AbC123/ --project demo list
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime
import hashlib
import hmac
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ElementTree

SCHEMA = "folder-sync-manifest/1"
ROOT_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
HOST_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()


class ContractError(Exception):
    """The bucket does not follow docs/CONTRACT.md."""


@dataclasses.dataclass(frozen=True)
class GetResult:
    status: int  # 200, 304 or 404
    body: bytes = b""
    etag: str = ""


# --- Stores: the two S3 calls the contract needs -----------------------------------------


def _uri_encode(text: str, keep_slash: bool = False) -> str:
    safe = "-_.~" + ("/" if keep_slash else "")
    return urllib.parse.quote(text, safe=safe)


def sign_v4(method: str, url: str, headers: dict[str, str], access_key_id: str,
            secret_access_key: str, region: str, now: datetime.datetime,
            payload_hash: str = EMPTY_SHA256) -> dict[str, str]:
    """Return headers with SigV4 authentication added (every given header is signed)."""
    parsed = urllib.parse.urlsplit(url)
    amz_date = now.astimezone(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    day = amz_date[:8]
    signed = {key.lower(): str(value).strip() for key, value in headers.items()}
    signed["host"] = parsed.netloc
    signed["x-amz-date"] = amz_date
    signed["x-amz-content-sha256"] = payload_hash
    names = sorted(signed)
    canonical_headers = "".join(f"{name}:{signed[name]}\n" for name in names)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    canonical_query = "&".join(
        f"{_uri_encode(key)}={_uri_encode(value)}" for key, value in sorted(query))
    canonical_request = "\n".join([
        method, parsed.path or "/", canonical_query, canonical_headers, ";".join(names), payload_hash])
    scope = f"{day}/{region}/s3/aws4_request"
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical_request.encode()).hexdigest()])
    key = ("AWS4" + secret_access_key).encode()
    for part in (day, region, "s3", "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, string_to_sign.encode(), hashlib.sha256).hexdigest()
    out = {name: value for name, value in signed.items() if name != "host"}
    out["authorization"] = (f"AWS4-HMAC-SHA256 Credential={access_key_id}/{scope}, "
                            f"SignedHeaders={';'.join(names)}, Signature={signature}")
    return out


class StdlibStore:
    """Path-style S3 access with the standard library (R2 or any S3-compatible endpoint)."""

    def __init__(self, endpoint: str, access_key_id: str, secret_access_key: str,
                 bucket: str, region: str = "auto", timeout: float = 30.0):
        self.endpoint = endpoint.rstrip("/")
        self.access_key_id = access_key_id
        self.secret_access_key = secret_access_key
        self.bucket = bucket
        self.region = region
        self.timeout = timeout

    def _request(self, method: str, url: str, headers: dict[str, str]) -> tuple[int, bytes, dict[str, str]]:
        now = datetime.datetime.now(datetime.timezone.utc)
        signed = sign_v4(method, url, headers, self.access_key_id, self.secret_access_key, self.region, now)
        request = urllib.request.Request(url, method=method, headers=signed)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.status, response.read(), dict(response.headers)
        except urllib.error.HTTPError as error:
            body = error.read() if error.code not in (304,) else b""
            return error.code, body, dict(error.headers or {})

    def get(self, key: str, if_none_match: str = "") -> GetResult:
        url = f"{self.endpoint}/{_uri_encode(self.bucket)}/{_uri_encode(key, keep_slash=True)}"
        headers = {"if-none-match": if_none_match} if if_none_match else {}
        status, body, response_headers = self._request("GET", url, headers)
        etag = {name.lower(): value for name, value in response_headers.items()}.get("etag", "")
        if status == 304 or (status == 200 and if_none_match and etag == if_none_match):
            return GetResult(304, etag=if_none_match)
        if status == 404:
            return GetResult(404)
        if status != 200:
            raise ContractError(f"GET {key}: HTTP {status}: {body[:300]!r}")
        return GetResult(200, body, etag)

    def list_prefixes(self, prefix: str) -> list[str]:
        prefixes: list[str] = []
        token = ""
        while True:
            query = {"list-type": "2", "prefix": prefix, "delimiter": "/"}
            if token:
                query["continuation-token"] = token
            url = (f"{self.endpoint}/{_uri_encode(self.bucket)}?"
                   + urllib.parse.urlencode(query, quote_via=urllib.parse.quote))
            status, body, _ = self._request("GET", url, {})
            if status != 200:
                raise ContractError(f"LIST {prefix}: HTTP {status}: {body[:300]!r}")
            root = ElementTree.fromstring(body)
            namespace = root.tag.split("}")[0] + "}" if root.tag.startswith("{") else ""
            for element in root.iter(f"{namespace}CommonPrefixes"):
                found = element.find(f"{namespace}Prefix")
                if found is not None and found.text:
                    prefixes.append(found.text)
            truncated = root.find(f"{namespace}IsTruncated")
            next_token = root.find(f"{namespace}NextContinuationToken")
            if truncated is None or truncated.text != "true" or next_token is None:
                return prefixes
            token = next_token.text or ""


class Boto3Store:
    """The same two calls through a boto3 S3 client (optional dependency)."""

    def __init__(self, client, bucket: str):
        self.client = client
        self.bucket = bucket

    def get(self, key: str, if_none_match: str = "") -> GetResult:
        import botocore.exceptions  # noqa: PLC0415 (optional dependency)

        kwargs = {"Bucket": self.bucket, "Key": key}
        if if_none_match:
            kwargs["IfNoneMatch"] = if_none_match
        try:
            response = self.client.get_object(**kwargs)
        except botocore.exceptions.ClientError as error:
            code = str(error.response.get("Error", {}).get("Code", ""))
            if code in ("304", "NotModified"):
                return GetResult(304, etag=if_none_match)
            if code in ("404", "NoSuchKey"):
                return GetResult(404)
            raise
        return GetResult(200, response["Body"].read(), response.get("ETag", ""))

    def list_prefixes(self, prefix: str) -> list[str]:
        prefixes: list[str] = []
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix, Delimiter="/"):
            prefixes.extend(item["Prefix"] for item in page.get("CommonPrefixes", []))
        return prefixes


# --- The contract ------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class FileRef:
    project: str
    host_id: str
    host_name: str
    path: str
    size: int
    mtime: str
    sha256: str
    written_at: str
    root: str = ""

    @property
    def key(self) -> str:
        return f"{self.root}{self.project}/hosts/{self.host_id}/{self.path}"


def check_root(root: str) -> None:
    """An account root is "" or one to eight slash-ended segments, like "users/AbC123/" (docs/CONTRACT.md)."""
    if root == "":
        return
    *segments, last = root.split("/")
    if last != "" or not 1 <= len(segments) <= 8 or not all(ROOT_SEGMENT.match(s) for s in segments):
        raise ContractError(f"bad account root {root!r}")


def check_path(path: str) -> None:
    if (not path or path.startswith("/") or "\\" in path or (len(path) >= 2 and path[1] == ":")
            or any(segment in ("", ".", "..") for segment in path.split("/"))):
        raise ContractError(f"unsafe manifest path {path!r}")


def validate_manifest(manifest: dict, project: str, host_id: str) -> dict:
    if manifest.get("schema") != SCHEMA:
        raise ContractError(f"manifest schema {manifest.get('schema')!r}, this reader knows {SCHEMA!r}")
    if manifest.get("project") != project or manifest.get("host_id") != host_id:
        raise ContractError(f"manifest under hosts/{host_id} claims {manifest.get('project')}/{manifest.get('host_id')}")
    seen = set()
    for entry in manifest.get("files", []):
        check_path(entry["path"])
        if entry["path"] in seen:
            raise ContractError(f"manifest lists {entry['path']!r} twice")
        seen.add(entry["path"])
        if not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]) or int(entry["size"]) < 0:
            raise ContractError(f"bad entry {entry['path']!r}")
    return manifest


class Project:
    """One project's view: the union of every host's manifest."""

    def __init__(self, store, project: str, root: str = ""):
        """root: the account root every key starts with ("" = folder-sync v0, unchanged)."""
        check_root(root)
        self.store = store
        self.project = project
        self.root = root
        self._manifests: dict[str, tuple[str, dict]] = {}  # host_id -> (etag, manifest)
        self._hosts: list[str] | None = None

    def hosts(self, refresh: bool = False) -> list[str]:
        """Host ids, from one delimiter listing of <project>/hosts/ (cached)."""
        if self._hosts is None or refresh:
            prefix = f"{self.root}{self.project}/hosts/"
            found = [p[len(prefix):].rstrip("/") for p in self.store.list_prefixes(prefix)]
            self._hosts = sorted(host for host in found if HOST_ID.match(host))
        return self._hosts

    def manifest(self, host_id: str) -> dict | None:
        """The host's manifest, re-fetched only if its ETag changed (conditional GET)."""
        etag, cached = self._manifests.get(host_id, ("", None))
        result = self.store.get(f"{self.root}{self.project}/hosts/{host_id}/manifest.json", etag)
        if result.status == 304 and cached is not None:
            return cached
        if result.status == 404:
            self._manifests.pop(host_id, None)
            return None
        manifest = validate_manifest(json.loads(result.body), self.project, host_id)
        self._manifests[host_id] = (result.etag, manifest)
        return manifest

    def files(self) -> list[FileRef]:
        refs = []
        for host_id in self.hosts():
            manifest = self.manifest(host_id)
            if manifest is None:
                continue
            for entry in manifest["files"]:
                refs.append(FileRef(self.project, host_id, manifest.get("host_name", ""), entry["path"],
                                    int(entry["size"]), entry["mtime"], entry["sha256"], entry["written_at"], self.root))
        return sorted(refs, key=lambda ref: (ref.host_id, ref.path))

    def read(self, host_id: str, path: str, verify: bool = True) -> bytes:
        """A file's bytes. On a race with the writer (404 or sha mismatch), re-read the manifest once."""
        check_path(path)
        for attempt in range(2):
            manifest = self.manifest(host_id)
            entry = next((e for e in (manifest or {}).get("files", []) if e["path"] == path), None)
            if entry is None:
                raise FileNotFoundError(f"{host_id}/{path} is not in the manifest (deleted, or never published)")
            result = self.store.get(f"{self.root}{self.project}/hosts/{host_id}/{path}")
            if result.status == 200 and (not verify or hashlib.sha256(result.body).hexdigest() == entry["sha256"]):
                return result.body
            self._manifests.pop(host_id, None)  # the writer moved on; take its next manifest
        raise ContractError(f"{host_id}/{path} kept changing while it was read")


# --- Command line ------------------------------------------------------------------------


def store_from_env(bucket: str) -> StdlibStore:
    endpoint = os.environ.get("FOLDER_SYNC_ENDPOINT") or (
        f"https://{os.environ['FOLDER_SYNC_ACCOUNT_ID']}.r2.cloudflarestorage.com"
        if os.environ.get("FOLDER_SYNC_ACCOUNT_ID") else "")
    key_id = os.environ.get("FOLDER_SYNC_ACCESS_KEY_ID", "")
    secret = os.environ.get("FOLDER_SYNC_SECRET_ACCESS_KEY", "")
    if not (endpoint and key_id and secret):
        sys.exit("set FOLDER_SYNC_ACCESS_KEY_ID, FOLDER_SYNC_SECRET_ACCESS_KEY and FOLDER_SYNC_ACCOUNT_ID (or FOLDER_SYNC_ENDPOINT)")
    return StdlibStore(endpoint, key_id, secret, bucket, os.environ.get("FOLDER_SYNC_REGION", "auto"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read a folder-sync project (docs/CONTRACT.md).")
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--root", default="", help='account root, like "users/AbC123/" (default: none)')
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list", help="every file of every host, as JSON lines")
    cat = commands.add_parser("cat", help="print one file")
    cat.add_argument("host_id")
    cat.add_argument("path")
    args = parser.parse_args(argv)
    project = Project(store_from_env(args.bucket), args.project, args.root)
    if args.command == "list":
        for ref in project.files():
            print(json.dumps(dataclasses.asdict(ref) | {"key": ref.key}))
    else:
        sys.stdout.buffer.write(project.read(args.host_id, args.path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
