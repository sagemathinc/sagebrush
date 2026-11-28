-- LtiRegistry, stage A (plan-lti-r5 §15.1, §7.1, §17.1).
-- Admission is constant work: quota rows maintained by triggers, so the cap
-- check, the row and the counter commit or fail together.  A missing quota
-- row aborts (fails closed).

CREATE TABLE quota (
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  cap_count INTEGER NOT NULL,
  cap_bytes INTEGER NOT NULL,
  PRIMARY KEY (scope, kind)
) WITHOUT ROWID;

-- The environment's own quota rows.  Per-registration rows are inserted with
-- the registration (same batch).
INSERT INTO quota (scope, kind, cap_count, cap_bytes) VALUES
  ('env', 'registrations', 100, 409600),
  ('env', 'pending', 20, 81920),
  ('env', 'codes', 20, 47104),
  ('env', 'admin_requests', 100000, 6400000);

-- Registrations (approved, pending, revoked): ≤ 100, ≤ 4 KiB each.
CREATE TABLE registrations (
  rid TEXT PRIMARY KEY CHECK (length(rid) = 32),
  owner_ref TEXT NOT NULL CHECK (length(owner_ref) BETWEEN 1 AND 64),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('license', 'organization')),
  state TEXT NOT NULL CHECK (state IN ('bootstrapping', 'pending', 'approved', 'revoked')),
  iss TEXT CHECK (iss IS NULL OR length(CAST(iss AS BLOB)) <= 255),
  client_id TEXT CHECK (client_id IS NULL OR length(CAST(client_id AS BLOB)) <= 255),
  preset TEXT CHECK (preset IS NULL OR preset IN ('canvas-cloud', 'canvas-self', 'moodle')),
  bootstrap TEXT NOT NULL CHECK (length(CAST(bootstrap AS BLOB)) <= 512),
  policy TEXT CHECK (policy IS NULL OR length(CAST(policy AS BLOB)) <= 2560),
  policy_version INTEGER NOT NULL DEFAULT 0,
  policy_digest TEXT,
  staff_digest TEXT,
  approved_digest TEXT,
  created INTEGER NOT NULL,
  size INTEGER NOT NULL CHECK (size <= 4096),
  CHECK (size = 32 + length(CAST(owner_ref AS BLOB)) + 16 + 16 + coalesce(length(CAST(iss AS BLOB)), 0)
    + coalesce(length(CAST(client_id AS BLOB)), 0) + 16 + length(CAST(bootstrap AS BLOB))
    + coalesce(length(CAST(policy AS BLOB)), 0) + 8 + 3 * 64 + 8)
);
CREATE UNIQUE INDEX registrations_iss_client ON registrations (iss, client_id) WHERE iss IS NOT NULL AND client_id IS NOT NULL;
CREATE INDEX registrations_owner ON registrations (owner_ref);

CREATE TRIGGER registrations_quota_insert BEFORE INSERT ON registrations
BEGIN
  SELECT RAISE(ABORT, 'quota') WHERE NOT EXISTS (SELECT 1 FROM quota WHERE scope = 'env' AND kind = 'registrations' AND count < cap_count AND bytes + NEW.size <= cap_bytes);
  SELECT RAISE(ABORT, 'quota') WHERE NEW.state IN ('bootstrapping', 'pending') AND NOT EXISTS (SELECT 1 FROM quota WHERE scope = 'env' AND kind = 'pending' AND count < cap_count);
  UPDATE quota SET count = count + 1, bytes = bytes + NEW.size WHERE scope = 'env' AND kind = 'registrations';
  UPDATE quota SET count = count + 1 WHERE scope = 'env' AND kind = 'pending' AND NEW.state IN ('bootstrapping', 'pending');
END;
CREATE TRIGGER registrations_quota_delete AFTER DELETE ON registrations
BEGIN
  UPDATE quota SET count = count - 1, bytes = bytes - OLD.size WHERE scope = 'env' AND kind = 'registrations';
  UPDATE quota SET count = count - 1 WHERE scope = 'env' AND kind = 'pending' AND OLD.state IN ('bootstrapping', 'pending');
END;
CREATE TRIGGER registrations_quota_size BEFORE UPDATE OF size ON registrations WHEN NEW.size > OLD.size
BEGIN
  SELECT RAISE(ABORT, 'quota') WHERE NOT EXISTS (SELECT 1 FROM quota WHERE scope = 'env' AND kind = 'registrations' AND bytes + NEW.size - OLD.size <= cap_bytes);
END;
CREATE TRIGGER registrations_quota_size_after AFTER UPDATE OF size ON registrations
BEGIN
  UPDATE quota SET bytes = bytes + NEW.size - OLD.size WHERE scope = 'env' AND kind = 'registrations';
END;
CREATE TRIGGER registrations_pending_state AFTER UPDATE OF state ON registrations
WHEN (OLD.state IN ('bootstrapping', 'pending')) <> (NEW.state IN ('bootstrapping', 'pending'))
BEGIN
  UPDATE quota SET count = count + (CASE WHEN NEW.state IN ('bootstrapping', 'pending') THEN 1 ELSE -1 END) WHERE scope = 'env' AND kind = 'pending';
END;
CREATE TRIGGER registrations_pending_cap BEFORE UPDATE OF state ON registrations
WHEN NEW.state IN ('bootstrapping', 'pending') AND OLD.state NOT IN ('bootstrapping', 'pending')
BEGIN
  SELECT RAISE(ABORT, 'quota') WHERE NOT EXISTS (SELECT 1 FROM quota WHERE scope = 'env' AND kind = 'pending' AND count < cap_count);
END;
-- (owner_ref is immutable, §17.1)
CREATE TRIGGER registrations_owner_immutable BEFORE UPDATE OF owner_ref, owner_kind ON registrations
WHEN NEW.owner_ref <> OLD.owner_ref OR NEW.owner_kind <> OLD.owner_kind
BEGIN
  SELECT RAISE(ABORT, 'owner_immutable');
END;

-- Registration codes: ≤ 20 live, single use, 24 h, ≤ 256 B.  The code itself
-- is never stored, only its hash.
CREATE TABLE codes (
  code_hash TEXT PRIMARY KEY CHECK (length(code_hash) = 64),
  owner_ref TEXT NOT NULL CHECK (length(owner_ref) BETWEEN 1 AND 64),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('license', 'organization')),
  preset TEXT NOT NULL CHECK (preset IN ('canvas-cloud', 'canvas-self', 'moodle')),
  bootstrap TEXT NOT NULL CHECK (length(CAST(bootstrap AS BLOB)) <= 512),
  expires INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('live', 'reserved')),
  rid TEXT,
  size INTEGER NOT NULL CHECK (size = 64 + length(CAST(owner_ref AS BLOB)) + 16 + 16 + length(CAST(bootstrap AS BLOB)) + 8 + 8 + 32 AND size <= 1024)
);
CREATE INDEX codes_expires ON codes (expires);
-- (the table's fixed charge, errata r2)
UPDATE quota SET bytes = 16384 WHERE scope = 'env' AND kind = 'codes';
CREATE TRIGGER codes_quota_insert BEFORE INSERT ON codes
BEGIN
  -- (charge errata r2: 16,384 B fixed for the table and its index, charged at creation below, plus 1,536 B a row)
  SELECT RAISE(ABORT, 'quota') WHERE NOT EXISTS (SELECT 1 FROM quota WHERE scope = 'env' AND kind = 'codes' AND count < cap_count AND bytes + 1536 <= cap_bytes);
  UPDATE quota SET count = count + 1, bytes = bytes + 1536 WHERE scope = 'env' AND kind = 'codes';
END;
CREATE TRIGGER codes_quota_delete AFTER DELETE ON codes
BEGIN
  UPDATE quota SET count = count - 1, bytes = bytes - 1536 WHERE scope = 'env' AND kind = 'codes';
END;

-- Deployments: ≤ 50 per registration, ≤ 512 B.
CREATE TABLE deployments (
  rid TEXT NOT NULL,
  deployment_id TEXT NOT NULL CHECK (length(CAST(deployment_id AS BLOB)) BETWEEN 1 AND 255),
  size INTEGER NOT NULL CHECK (size = 32 + length(CAST(deployment_id AS BLOB)) + 8),
  PRIMARY KEY (rid, deployment_id)
) WITHOUT ROWID;
CREATE TRIGGER deployments_quota_insert BEFORE INSERT ON deployments
BEGIN
  SELECT RAISE(ABORT, 'quota') WHERE NOT EXISTS (SELECT 1 FROM quota WHERE scope = NEW.rid AND kind = 'deployments' AND count < cap_count AND bytes + NEW.size <= cap_bytes);
  UPDATE quota SET count = count + 1, bytes = bytes + NEW.size WHERE scope = NEW.rid AND kind = 'deployments';
END;
CREATE TRIGGER deployments_quota_delete AFTER DELETE ON deployments
BEGIN
  UPDATE quota SET count = count - 1, bytes = bytes - OLD.size WHERE scope = OLD.rid AND kind = 'deployments';
END;

-- Admin request ids, kept 1 day so replays are refused (§17.1).
CREATE TABLE admin_requests (
  request_id TEXT PRIMARY KEY CHECK (length(request_id) BETWEEN 16 AND 64),
  at INTEGER NOT NULL
);
CREATE INDEX admin_requests_at ON admin_requests (at);
CREATE TRIGGER admin_requests_quota_insert BEFORE INSERT ON admin_requests
BEGIN
  SELECT RAISE(ABORT, 'quota') WHERE NOT EXISTS (SELECT 1 FROM quota WHERE scope = 'env' AND kind = 'admin_requests' AND count < cap_count);
  UPDATE quota SET count = count + 1, bytes = bytes + 64 WHERE scope = 'env' AND kind = 'admin_requests';
END;
CREATE TRIGGER admin_requests_quota_delete AFTER DELETE ON admin_requests
BEGIN
  UPDATE quota SET count = count - 1, bytes = bytes - 64 WHERE scope = 'env' AND kind = 'admin_requests';
END;

-- CORR-LTIA-2: revoked is terminal for every write path, not only the ones that check it
CREATE TRIGGER registrations_revoked_terminal BEFORE UPDATE OF state ON registrations WHEN OLD.state = 'revoked' AND NEW.state <> 'revoked'
BEGIN
  SELECT RAISE(ABORT, 'revoked');
END;
