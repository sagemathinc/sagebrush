-- Other services' claims on an account's one storage budget (storage_bytes, sync-server §6.1), beside sharing's own
-- bytes and sync's claim: one row per (account, holder), raised and lowered only by its holder, never negative, and
-- counted by every check of the budget (SHARING_USED).  A holder is a fixed name its own code uses; no request picks
-- one.  Deleted with the account, in its purge's final batch.
CREATE TABLE budget_claims (
  account_id TEXT NOT NULL,
  holder TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  PRIMARY KEY (account_id, holder)
);
