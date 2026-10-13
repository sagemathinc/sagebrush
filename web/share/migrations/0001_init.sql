-- Shared collections on sagebrush.space (design: design/sharing.md).
-- Accounts are CoCalc accounts, keyed by account_id only (an email can be
-- reused by a later account).  Files are blobs in R2 named by SHA-256;
-- "holdings" says which account has uploaded (so holds, and is charged for)
-- which blob, and a blob is deleted when no account holds it.

CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  created INTEGER NOT NULL,
  last_login INTEGER
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,   -- SHA-256 of the cookie's token
  account_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);

CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  created INTEGER NOT NULL
);

CREATE TABLE holdings (
  account_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (account_id, sha256)
);
CREATE INDEX holdings_blob ON holdings(sha256);

CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  title TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  latest TEXT                    -- the latest version's manifest hash
);
CREATE INDEX collections_owner ON collections(owner);

CREATE TABLE versions (
  hash TEXT PRIMARY KEY,         -- SHA-256 of the manifest's canonical JSON
  collection TEXT NOT NULL,
  owner TEXT NOT NULL,
  created INTEGER NOT NULL,
  size INTEGER NOT NULL
);
CREATE INDEX versions_collection ON versions(collection);
CREATE INDEX versions_owner ON versions(owner);

CREATE TABLE version_blobs (
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (version, sha256)
);
CREATE INDEX version_blobs_blob ON version_blobs(sha256);

CREATE TABLE limits_cache (
  account_id TEXT PRIMARY KEY,
  limits TEXT NOT NULL,
  fetched INTEGER NOT NULL
);

-- Deletions: what was asked, by whom, and what it removed (no content).
CREATE TABLE purges (
  request_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  collection TEXT,               -- null: everything the account has
  status TEXT NOT NULL,          -- pending | done
  collections INTEGER,
  bytes INTEGER,
  created INTEGER NOT NULL,
  finished INTEGER
);
