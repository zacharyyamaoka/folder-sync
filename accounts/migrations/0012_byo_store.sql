-- Bring your own tokens (PEP 0003 §3.11, src/byo.ts): one S3-compatible bucket a person attached on their account page.
-- "sealed" holds the access key id and the secret together, encrypted (AES-GCM, a key from the Worker secret
-- BYO_ENCRYPTION_KEY, bound to "owner_id"); nothing else in this table is secret. "key_hint" is the last four characters of
-- the key id, so the page can say which key is attached without holding the rest in the clear.
-- At most one bucket per person (the primary key); gone with the person (ON DELETE CASCADE).
CREATE TABLE "byo_store" (
  "owner_id" TEXT NOT NULL PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  "endpoint" TEXT NOT NULL,
  "bucket" TEXT NOT NULL,
  "prefix" TEXT NOT NULL DEFAULT '',
  "region" TEXT NOT NULL DEFAULT 'auto',
  "key_hint" TEXT NOT NULL,
  "sealed" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
