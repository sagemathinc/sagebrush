-- Admin visibility (admin-visibility-plan r1h, §1.8, §4 and §5): the account's last activity, as the UTC hour it
-- fell in (seconds, a multiple of 3600; written at most once an hour, only through a still-live session); the audit
-- log of /admin's views; and the admin grants, one per Sagebrush session, from cocalc.ai's fresh 2FA.  Needs
-- William's per-file OK before it is applied to PROD.
ALTER TABLE accounts ADD COLUMN last_active INTEGER;
CREATE TABLE admin_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  admin_id TEXT NOT NULL,       -- the viewer's account id
  view TEXT NOT NULL,           -- overview | accounts | account | health | denied
  target_hash TEXT,             -- view = account: sha256("sagebrush-account\n" + id), never the id
  factor_at INTEGER,            -- the grant's factor_verified_at (seconds) the view was admitted with
  fresh_until INTEGER,          -- the grant's expires_at, the freshness deadline the view was admitted under
  detail TEXT                   -- accounts: "sort=<k>&page=<n>"; denied: "not-admin" | "check-failed"; else NULL
);
CREATE INDEX admin_views_at ON admin_views(at);
CREATE INDEX admin_views_who ON admin_views(admin_id, view, at);  -- the denial dedupe's lookup
CREATE TABLE admin_grants (
  session TEXT PRIMARY KEY,     -- the Sagebrush session's token hash (sessions.token_hash)
  account_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,       -- cocalc.ai's opaque id
  factor_at INTEGER NOT NULL,   -- cocalc.ai's factor_verified_at (seconds)
  expires_at INTEGER NOT NULL
);
CREATE INDEX admin_grants_account ON admin_grants(account_id);
CREATE INDEX admin_grants_expires ON admin_grants(expires_at);
