-- folder-sync accounts (PEP 0003 §3.1): Better Auth 1.7.11's tables for the plugins src/auth.ts loads (Google sign-in,
-- bearer, device authorization; email codes in dev only, which use "verification"), then folder-sync's own three.
-- Better Auth's part is moved from Vibe Tracks' worker/migrations/0001_accounts.sql (the same version, kept by hand from
-- its schema: core tables as Simple Hosted Files' migration 0001, "deviceCode" from the plugin's schema.mjs), so
-- PEP 0003 §4's move of Vibe Tracks' rows into this database keeps every id. Applied with `wrangler d1 migrations apply`.
-- WHY foreign keys with cascade: deleting a person takes their sessions (every device grant), linked accounts, folder
-- rows, readers and web hosts.

CREATE TABLE "user" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL,
  "image" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE TABLE "session" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" DATE NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE "account" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" DATE,
  "refreshTokenExpiresAt" DATE,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE TABLE "verification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

-- RFC 8628 device codes (the deviceAuthorization plugin): one row per `folder-sync login` waiting to be approved.
CREATE TABLE "deviceCode" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "deviceCode" TEXT NOT NULL UNIQUE,
  "userCode" TEXT NOT NULL UNIQUE,
  "userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
  "expiresAt" DATE NOT NULL,
  "status" TEXT NOT NULL,
  "lastPolledAt" DATE,
  "pollingInterval" INTEGER,
  "clientId" TEXT,
  "scope" TEXT
);

-- Better Auth's rate-limit counters (rateLimit.storage = "database"): Workers memory is per isolate.
CREATE TABLE "rateLimit" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL UNIQUE,
  "count" INTEGER NOT NULL,
  "lastRequest" BIGINT NOT NULL
);

CREATE INDEX "session_userId_idx" ON "session" ("userId");
CREATE INDEX "account_userId_idx" ON "account" ("userId");
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

-- folder-sync's own (§3.1). A folder has a row only once it is published or shared: no row = private.
CREATE TABLE "folder" (
  "owner_id" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "project" TEXT NOT NULL,
  "visibility" TEXT NOT NULL CHECK ("visibility" IN ('private', 'public')),
  "updated_at" TEXT NOT NULL,
  PRIMARY KEY ("owner_id", "project")
);

-- Who else may read a private folder, by email (the person need not have an account yet).
CREATE TABLE "folder_reader" (
  "owner_id" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "project" TEXT NOT NULL,
  "reader_email" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  PRIMARY KEY ("owner_id", "project", "reader_email")
);
CREATE INDEX "folder_reader_email_idx" ON "folder_reader" ("reader_email");

-- The folder's web writer (§3.4): this Worker is a folder-sync host for each (person, project) a browser writes to;
-- its id is a lowercase UUID v4 minted on the first write, its manifest's host_name is "web".
CREATE TABLE "web_host" (
  "owner_id" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "project" TEXT NOT NULL,
  "host_id" TEXT NOT NULL UNIQUE,
  "created_at" TEXT NOT NULL,
  PRIMARY KEY ("owner_id", "project")
);
