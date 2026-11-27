-- Grants: what an account may use beyond Sagebrush's free plan, for a time window that always ends (grants design d1,
-- d1r1).  Rows are never edited or deleted by the service: a change is a revocation plus a new grant, and every change
-- writes its grant_audit row in the same batch.  Additive only; read only with AUTH_PROVIDER "workos".  Needs William's
-- per-file OK before it is applied to PROD.
--
-- The entitlements are typed columns from one closed set; NULL means the grant gives nothing there.  A grant opens
-- access only: no column raises or bypasses a spending control.  A grant is active at t when revoked_at IS NULL AND
-- valid_from <= t < valid_until (seconds).
CREATE TABLE grants (
  id TEXT PRIMARY KEY CHECK (length(id) = 26 AND id NOT GLOB '*[^a-z2-7]*'),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 100),
  storage_bytes INTEGER CHECK (storage_bytes IS NULL OR (storage_bytes >= 0 AND storage_bytes <= 1099511627776)),
  private_links INTEGER CHECK (private_links IS NULL OR private_links = 1),
  remote INTEGER CHECK (remote IS NULL OR remote = 1),
  gpu INTEGER CHECK (gpu IS NULL OR gpu = 1),
  seats INTEGER CHECK (seats IS NULL OR (seats >= 1 AND seats <= 1000)),
  valid_from INTEGER NOT NULL CHECK (valid_from >= 0),
  valid_until INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('admin', 'stripe')),
  source_ref TEXT CHECK (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 200),
  request_hash TEXT CHECK (request_hash IS NULL OR length(request_hash) = 64),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  revoked_at INTEGER,
  revoked_by TEXT CHECK (revoked_by IS NULL OR length(revoked_by) BETWEEN 1 AND 100),
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 200),
  CHECK (valid_until > valid_from AND valid_until - valid_from <= 63072000),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (storage_bytes IS NOT NULL OR private_links IS NOT NULL OR remote IS NOT NULL OR gpu IS NOT NULL OR seats IS NOT NULL),
  UNIQUE (source, source_ref)
);
CREATE INDEX grants_account ON grants(account_id, valid_until);

CREATE TABLE grant_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  action TEXT NOT NULL CHECK (action IN ('create', 'revoke', 'seat_assign', 'seat_release')),
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 500)
);
CREATE INDEX grant_audit_grant ON grant_audit(grant_id, at);

-- An admin's grant writes in the last minute (one row per write; older rows are deleted by the next write's check).
CREATE TABLE grant_admin_hits (
  admin TEXT NOT NULL CHECK (length(admin) BETWEEN 1 AND 100),
  t INTEGER NOT NULL,
  id TEXT NOT NULL,
  PRIMARY KEY (admin, t, id)
);
