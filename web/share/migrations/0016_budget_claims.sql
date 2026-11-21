-- Other services' claims on an account's one storage budget (storage_bytes, sync-server §6.1), beside sharing's own
-- bytes and sync's claim: one row per (account, holder), raised and lowered only by its holder, never negative, and
-- counted by every check of the budget (sharingUsed) wherever this table exists.  A holder is a fixed name its own
-- code uses; no request picks one.  Deleted with the account, in its purge's final batch.
--
-- Deploy contract: once this table holds a row, the code that counts it must stay deployed: no rollback of the
-- Worker (site, sharing or sync) to a version from before this migration until every row is gone.  BUDGET_CLAIMS "on"
-- only lets a holder write; counting never depends on it, so unbinding it can't leave a claim uncounted.
CREATE TABLE budget_claims (
  account_id TEXT NOT NULL,
  holder TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  PRIMARY KEY (account_id, holder)
);
