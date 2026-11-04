-- The shared tree (docs/peps/0010): a folder that opts in gets one more host whose writer is the folder's Durable Object, as
-- the web host's is. Its id is a lowercase UUID v4 minted by `folder-sync share`; its manifest's host_name is "shared".
-- Additive: a new table, nothing rewritten or dropped. Applied with `wrangler d1 migrations apply`, which stays Zach's.
CREATE TABLE "shared_tree" (
  "owner_id" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "project" TEXT NOT NULL,
  "host_id" TEXT NOT NULL UNIQUE,
  "created_at" TEXT NOT NULL,
  PRIMARY KEY ("owner_id", "project")
);
