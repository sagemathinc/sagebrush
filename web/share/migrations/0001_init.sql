-- Shared collections on sagebrush.space (design/sharing.md).
--
-- Accounts are CoCalc accounts, keyed by account_id only (an email can be
-- reused by a later account).  Every object an account uploads is its own R2
-- object under the account's prefix a/<sha256(account_id)>/, with a random
-- name: nothing in R2 is shared between accounts or between uploads, so a
-- deletion can never remove someone else's bytes.  D1 says which objects are
-- live; an object D1 no longer references is deleted through the r2_deletes
-- outbox, retried until it is gone.

CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  created INTEGER NOT NULL,
  last_login INTEGER,
  deleting INTEGER               -- a deletion is in progress: no sessions, no writes
);

-- Accounts deleted in CoCalc, by sha256(account_id): never signed in again.
CREATE TABLE tombstones (
  account_hash TEXT PRIMARY KEY,
  created INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,   -- SHA-256 of the cookie's token
  account_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);

-- An account's uploaded files, by content: the R2 object `key` holds bytes
-- whose SHA-256 is sha256.
CREATE TABLE holdings (
  account_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  key TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (account_id, sha256)
);

-- Bytes promised to an upload in progress (counted in the quota until it
-- ends): taken by one conditional INSERT, so concurrent uploads can't all
-- pass the same check.  An expired reservation whose object no row
-- references is deleted by the scheduled job.
CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  key TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX reservations_account ON reservations(account_id);

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
  size INTEGER NOT NULL,         -- its files' bytes
  manifest_key TEXT NOT NULL,
  manifest_bytes INTEGER NOT NULL
);
CREATE INDEX versions_collection ON versions(collection);
CREATE INDEX versions_owner ON versions(owner);

CREATE TABLE version_blobs (
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (version, sha256)
);
CREATE INDEX version_blobs_blob ON version_blobs(sha256);

-- R2 objects (or, with prefix = 1, everything under a prefix) to delete: the
-- outbox.  A row goes only once R2 has confirmed the deletion.
CREATE TABLE r2_deletes (
  key TEXT PRIMARY KEY,
  prefix INTEGER NOT NULL DEFAULT 0,
  account_id TEXT,               -- (a prefix: whose; cleared when done)
  purge TEXT,                    -- (a prefix: the purge it finishes)
  created INTEGER NOT NULL
);

CREATE TABLE limits_cache (
  account_id TEXT PRIMARY KEY,
  limits TEXT NOT NULL,
  fetched INTEGER NOT NULL
);

-- Deletions: what was asked and what it removed.  Once done, the account is
-- recorded by a hash of its id only.
CREATE TABLE purges (
  request_id TEXT PRIMARY KEY,
  account_hash TEXT NOT NULL,
  account_id TEXT,               -- (only while it runs: cleared when done)
  collection TEXT,               -- null: everything the account has
  kind TEXT NOT NULL,            -- admin (CoCalc account deleted) | self | collection
  status TEXT NOT NULL,          -- pending | running | files | done
  lease INTEGER,                 -- (running: until when this run owns it)
  collections INTEGER,
  bytes INTEGER,
  created INTEGER NOT NULL,
  finished INTEGER
);

-- A batch's guard: inserting NULL here fails, which rolls the whole batch back.
CREATE TABLE guard (x INTEGER NOT NULL);

-- Small state: the inventory check's place in R2 (reconcile_cursor).
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
