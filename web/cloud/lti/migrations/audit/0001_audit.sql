-- LtiAudit, its own D1 (plan-lti-r5 §11.4, §15.1): ≤ 2,000,000 live rows,
-- ≤ 1 KiB each.  At the cap, audited actions are refused, never done unaudited.

CREATE TABLE quota (
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  cap_count INTEGER NOT NULL,
  cap_bytes INTEGER NOT NULL,
  PRIMARY KEY (scope, kind)
) WITHOUT ROWID;
INSERT INTO quota (scope, kind, cap_count, cap_bytes) VALUES ('env', 'audit', 2000000, 2097152000);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (length(action) <= 32),
  actor_ref TEXT CHECK (actor_ref IS NULL OR length(CAST(actor_ref AS BLOB)) <= 64),
  owner_ref TEXT CHECK (owner_ref IS NULL OR length(CAST(owner_ref AS BLOB)) <= 64),
  rid TEXT CHECK (rid IS NULL OR length(rid) = 32),
  detail TEXT NOT NULL CHECK (length(CAST(detail AS BLOB)) <= 768),
  size INTEGER NOT NULL CHECK (size = 8 + 8 + length(action) + coalesce(length(CAST(actor_ref AS BLOB)), 0) + coalesce(length(CAST(owner_ref AS BLOB)), 0) + coalesce(length(rid), 0) + length(CAST(detail AS BLOB)) + 16)
);
CREATE INDEX audit_at ON audit (at);
CREATE TRIGGER audit_quota_insert BEFORE INSERT ON audit
BEGIN
  SELECT RAISE(ABORT, 'quota') WHERE NOT EXISTS (SELECT 1 FROM quota WHERE scope = 'env' AND kind = 'audit' AND count < cap_count AND bytes + NEW.size <= cap_bytes);
  UPDATE quota SET count = count + 1, bytes = bytes + NEW.size WHERE scope = 'env' AND kind = 'audit';
END;
CREATE TRIGGER audit_quota_delete AFTER DELETE ON audit
BEGIN
  UPDATE quota SET count = count - 1, bytes = bytes - OLD.size WHERE scope = 'env' AND kind = 'audit';
END;
