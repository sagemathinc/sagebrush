-- The purge queries' indexes (HARD-SHARE-3): an account's purges by hash
-- (completion, the deletion records' cap), and the scheduled job's by status.
CREATE INDEX purges_account ON purges(account_hash, kind, created);
CREATE INDEX purges_status ON purges(status, kind);
