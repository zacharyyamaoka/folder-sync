-- Each person's storage as last measured (PEP 0003 §3.7, review r1 #7): bytes and objects under users/<id>/, counted
-- by listing it when keys are asked for and the measurement is older than QUOTA_RECHECK_S, plus what the web host
-- has written since.
CREATE TABLE "usage" (
  "owner_id" TEXT PRIMARY KEY NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "bytes" INTEGER NOT NULL,
  "objects" INTEGER NOT NULL,
  "measured_at" TEXT NOT NULL
);
