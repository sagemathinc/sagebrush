-- The sync service's one table in D1 (design/sync-server.md §9): which
-- accounts have synced data, by hash only, so a purge finds their account
-- object; written when sync is turned on and when a purge starts or ends,
-- never on an edit.  A finished purge keeps counts, never the account id.
CREATE TABLE sync_accounts (
  account_hash TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,         -- the hash's first 32 hex, as the account's R2 keys begin (s/<prefix>/)
  incarnation TEXT NOT NULL,    -- random, new each time sync is turned on from nothing: an enable must present it
  state TEXT NOT NULL,          -- active | deleting | purged
  created INTEGER NOT NULL,
  request_id TEXT,              -- the purge's, while one runs or after it ends
  kind TEXT,                    -- self | admin
  finished INTEGER,
  docs INTEGER,
  bytes INTEGER
);
CREATE INDEX sync_accounts_prefix ON sync_accounts(prefix);
