"""Unit tests for the Python reference reader (run: python3 -m unittest discover readers/python)."""

import datetime
import hashlib
import json
import unittest

import folder_sync_read as reader

HOST_A = "b55e9683-7854-4121-a56a-9bae7c3ab1da"
HOST_B = "26ec27de-c7e5-45fb-ad10-50b750c5b132"


def manifest(host_id, files, seq=1, project="demo"):
    return {
        "schema": reader.SCHEMA, "project": project, "host_id": host_id, "host_name": "box-" + host_id[:4],
        "seq": seq, "generated_at": "2026-10-20T22:00:00Z",
        "files": [{"path": path, "size": len(data), "mtime": "2026-10-20T21:00:00Z",
                   "sha256": hashlib.sha256(data).hexdigest(), "written_at": "2026-10-20T22:00:00Z"}
                  for path, data in files.items()],
    }


class MemoryStore:
    """An in-memory bucket that honours If-None-Match and counts calls."""

    def __init__(self):
        self.objects = {}
        self.calls = []

    def put(self, key, data):
        self.objects[key] = data

    def get(self, key, if_none_match=""):
        self.calls.append(("GET", key, if_none_match))
        if key not in self.objects:
            return reader.GetResult(404)
        etag = '"' + hashlib.md5(self.objects[key]).hexdigest() + '"'
        if if_none_match == etag:
            return reader.GetResult(304, etag=etag)
        return reader.GetResult(200, self.objects[key], etag)

    def list_prefixes(self, prefix):
        self.calls.append(("LIST", prefix, ""))
        found = set()
        for key in self.objects:
            if key.startswith(prefix):
                found.add(prefix + key[len(prefix):].split("/")[0] + "/")
        return sorted(found)


class SigV4Test(unittest.TestCase):
    def test_aws_documented_get_object_example(self):
        # AWS S3 docs, "Signature Calculations for the Authorization Header", Example: GET Object.
        headers = reader.sign_v4(
            "GET", "https://examplebucket.s3.amazonaws.com/test.txt", {"Range": "bytes=0-9"},
            "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1",
            datetime.datetime(2013, 5, 24, tzinfo=datetime.timezone.utc))
        self.assertEqual(
            headers["authorization"],
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
            "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
            "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41")


class ProjectTest(unittest.TestCase):
    def setUp(self):
        self.store = MemoryStore()
        self.store.put(f"demo/hosts/{HOST_A}/manifest.json",
                       json.dumps(manifest(HOST_A, {"notes/a.md": b"hello"})).encode())
        self.store.put(f"demo/hosts/{HOST_A}/notes/a.md", b"hello")
        self.store.put(f"demo/hosts/{HOST_B}/manifest.json", json.dumps(manifest(HOST_B, {})).encode())
        self.store.put("demo/hosts/not-a-host/x", b"ignored")
        self.store.put(f"_trash/demo/{HOST_A}/20261020T000000Z/old.md", b"old")
        self.project = reader.Project(self.store, "demo")

    def test_lists_every_host_from_manifests_only(self):
        files = self.project.files()
        self.assertEqual([(f.host_id, f.path, f.size) for f in files], [(HOST_A, "notes/a.md", 5)])
        self.assertEqual(files[0].key, f"demo/hosts/{HOST_A}/notes/a.md")
        self.assertEqual(self.project.hosts(), sorted([HOST_A, HOST_B]))
        lists = [call for call in self.store.calls if call[0] == "LIST"]
        self.assertEqual(lists, [("LIST", "demo/hosts/", "")])  # one delimiter listing, never the files

    def test_second_listing_uses_conditional_gets(self):
        self.project.files()
        self.store.calls.clear()
        self.project.files()
        self.assertTrue(all(call[0] == "GET" and call[2] for call in self.store.calls), self.store.calls)

    def test_read_verifies_sha256_and_retries_once(self):
        self.assertEqual(self.project.read(HOST_A, "notes/a.md"), b"hello")
        # The writer overwrites the file but the reader still holds the old manifest.
        self.store.put(f"demo/hosts/{HOST_A}/notes/a.md", b"hello v2")
        self.store.put(f"demo/hosts/{HOST_A}/manifest.json",
                       json.dumps(manifest(HOST_A, {"notes/a.md": b"hello v2"}, seq=2)).encode())
        self.assertEqual(self.project.read(HOST_A, "notes/a.md"), b"hello v2")

    def test_deleted_file_is_not_found(self):
        self.store.put(f"demo/hosts/{HOST_A}/manifest.json", json.dumps(manifest(HOST_A, {}, seq=2)).encode())
        with self.assertRaises(FileNotFoundError):
            self.project.read(HOST_A, "notes/a.md")

    def test_rejects_other_schema_and_unsafe_paths(self):
        bad = manifest(HOST_A, {"x": b"x"})
        bad["schema"] = "folder-sync-manifest/2"
        with self.assertRaises(reader.ContractError):
            reader.validate_manifest(bad, "demo", HOST_A)
        for path in ("../etc/passwd", "/abs", "a/../b", "a\\b", "C:/x", "a//b"):
            evil = manifest(HOST_A, {path: b"x"})
            with self.assertRaises(reader.ContractError, msg=path):
                reader.validate_manifest(evil, "demo", HOST_A)
        with self.assertRaises(reader.ContractError):
            reader.validate_manifest(manifest(HOST_B, {}), "demo", HOST_A)


class AccountRootTest(unittest.TestCase):
    ROOT = "users/AbC123/"

    def setUp(self):
        self.store = MemoryStore()
        self.store.put(f"{self.ROOT}demo/hosts/{HOST_A}/manifest.json",
                       json.dumps(manifest(HOST_A, {"notes/a.md": b"hello"})).encode())
        self.store.put(f"{self.ROOT}demo/hosts/{HOST_A}/notes/a.md", b"hello")
        # Another person's project and a v0 project in the same bucket stay invisible.
        self.store.put(f"users/Other1/demo/hosts/{HOST_B}/manifest.json", json.dumps(manifest(HOST_B, {})).encode())
        self.store.put(f"demo/hosts/{HOST_B}/manifest.json", json.dumps(manifest(HOST_B, {})).encode())

    def test_every_key_starts_with_the_root(self):
        project = reader.Project(self.store, "demo", root=self.ROOT)
        files = project.files()
        self.assertEqual([(f.host_id, f.path, f.key) for f in files],
                         [(HOST_A, "notes/a.md", f"{self.ROOT}demo/hosts/{HOST_A}/notes/a.md")])
        self.assertEqual(project.read(HOST_A, "notes/a.md"), b"hello")
        self.assertEqual(project.hosts(), [HOST_A])
        self.assertEqual([c for c in self.store.calls if c[0] == "LIST"], [("LIST", f"{self.ROOT}demo/hosts/", "")])

    def test_no_root_reads_as_v0_does(self):
        self.assertEqual(reader.Project(self.store, "demo").hosts(), [HOST_B])

    def test_rejects_a_bad_root(self):
        for root in ("users/x", "/users/x/", "users//x/", "users/../x/", "../", "a/b/c/d/e/f/g/h/i/"):
            with self.assertRaises(reader.ContractError, msg=root):
                reader.Project(self.store, "demo", root=root)
        for root in ("", "users/AbC123/", "a/", "a/b/c/d/e/f/g/h/"):
            reader.check_root(root)


if __name__ == "__main__":
    unittest.main()
