-- The sync service's one table in D1 (design/sync-server.md §9): which
-- accounts have synced data, by hash only, so a purge finds their account
-- object; written when sync is turned on and when a purge starts or ends,
-- never on an edit.  A finished purge keeps counts, never the account id.
CREATE TABLE sync_accounts (
  account_hash TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,         -- the hash's first 32 hex, as the account's R2 keys begin (s/<prefix>/)
  generation INTEGER NOT NULL,  -- 1, 2, 3, ...: raised each time sync is turned on from nothing; an enable must present it
  state TEXT NOT NULL,          -- active | deleting | purged
  created INTEGER NOT NULL,
  request_id TEXT,              -- the purge's, while one runs or after it ends
  kind TEXT,                    -- self | admin
  finished INTEGER,
  docs INTEGER,
  bytes INTEGER
);
CREATE INDEX sync_accounts_prefix ON sync_accounts(prefix);
-- One receipt per CoCalc purge request, by its id (CORR-1C2-1): what CoCalc's
-- status call answers, apart from the account's row, which a later request
-- would change.  Written once the account object has answered, only for an
-- account that held sync state (the request id is bound to its account
-- before that, by sharing's purges row, CORR-E9C-1); completed with the
-- purge's D1 record; kept 30 days after it finished (90 if it never did),
-- then pruned by the daily job.  At most 8 an account, a new id evicting its
-- oldest, and none for an account that never synced (LIMIT-233-1, LIMIT-5DC-1).
CREATE TABLE sync_admin_requests (
  request_id TEXT PRIMARY KEY,
  account_hash TEXT NOT NULL,
  state TEXT NOT NULL,          -- deleting | purged
  created INTEGER NOT NULL,
  finished INTEGER,
  docs INTEGER,
  bytes INTEGER
);
CREATE INDEX sync_admin_requests_account ON sync_admin_requests(account_hash);  -- per-account eviction, newest by rowid
CREATE INDEX sync_admin_requests_finished ON sync_admin_requests(finished) WHERE state = 'purged';  -- prune: done
CREATE INDEX sync_admin_requests_open ON sync_admin_requests(created) WHERE state = 'deleting';  -- prune: never done
