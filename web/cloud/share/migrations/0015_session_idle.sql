-- Sessions with an idle limit, and per-account limits, for a deployment whose sign-in is its own (AUTH_PROVIDER
-- "local"; nothing of that sign-in is here).  Additive only: every existing row keeps idle_s NULL (no idle limit), and
-- nothing here changes a deployment without AUTH_PROVIDER "local".
--
-- idle_s: the session ends idle_s seconds after its holder's last activity (last_used), and never after abs_expires;
-- expires is kept at MIN(abs_expires, last_used + idle_s), so every check of expires is also the idle check.
ALTER TABLE sessions ADD COLUMN idle_s INTEGER;
ALTER TABLE sessions ADD COLUMN last_used INTEGER;

-- An account's own limits (AUTH_PROVIDER "local"), in place of DEFAULT_LIMITS.
CREATE TABLE account_limits (
  account_id TEXT PRIMARY KEY,
  storage_bytes INTEGER NOT NULL CHECK (storage_bytes >= 0),
  max_file_bytes INTEGER NOT NULL CHECK (max_file_bytes >= 0 AND max_file_bytes <= storage_bytes)
);
