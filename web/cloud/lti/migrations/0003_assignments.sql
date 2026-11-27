-- Assignments (plan-lti-r5 §7.2, §15.1): ≤ 2,000 per owner, a public catalog of
-- ≤ 10,000, ≤ 1 KiB a row.  The bundle itself is content-addressed in R2.
INSERT INTO quota (scope, kind, cap_count, cap_bytes) VALUES ('env', 'public_assignments', 10000, 10240000);

CREATE TABLE assignments (
  aid TEXT PRIMARY KEY CHECK (length(aid) = 32),
  owner_ref TEXT NOT NULL CHECK (length(CAST(owner_ref AS BLOB)) BETWEEN 1 AND 64),
  title TEXT NOT NULL CHECK (length(CAST(title AS BLOB)) BETWEEN 1 AND 255),
  rev INTEGER NOT NULL CHECK (rev >= 1),
  runtime_policy TEXT NOT NULL CHECK (runtime_policy IN ('browser', 'cocalc', 'either')),
  max_points REAL NOT NULL CHECK (max_points >= 0 AND max_points <= 100000),
  visibility TEXT NOT NULL CHECK (visibility IN ('institution', 'public')),
  bundle_sha TEXT NOT NULL CHECK (length(bundle_sha) = 64),
  updated INTEGER NOT NULL,
  size INTEGER NOT NULL CHECK (size = 32 + length(CAST(owner_ref AS BLOB)) + length(CAST(title AS BLOB)) + 8 + 16 + 8 + 16 + 64 + 8 + 8 AND size <= 1024)
);
CREATE INDEX assignments_owner ON assignments (owner_ref);
CREATE TRIGGER assignments_quota_insert BEFORE INSERT ON assignments
BEGIN
  SELECT RAISE(ABORT, 'quota') WHERE NOT EXISTS (SELECT 1 FROM quota WHERE scope = NEW.owner_ref AND kind = 'assignments' AND count < cap_count AND bytes + NEW.size <= cap_bytes);
  SELECT RAISE(ABORT, 'quota') WHERE NEW.visibility = 'public' AND NOT EXISTS (SELECT 1 FROM quota WHERE scope = 'env' AND kind = 'public_assignments' AND count < cap_count);
  UPDATE quota SET count = count + 1, bytes = bytes + NEW.size WHERE scope = NEW.owner_ref AND kind = 'assignments';
  UPDATE quota SET count = count + 1, bytes = bytes + NEW.size WHERE scope = 'env' AND kind = 'public_assignments' AND NEW.visibility = 'public';
END;
CREATE TRIGGER assignments_quota_delete AFTER DELETE ON assignments
BEGIN
  UPDATE quota SET count = count - 1, bytes = bytes - OLD.size WHERE scope = OLD.owner_ref AND kind = 'assignments';
  UPDATE quota SET count = count - 1, bytes = bytes - OLD.size WHERE scope = 'env' AND kind = 'public_assignments' AND OLD.visibility = 'public';
END;
CREATE TRIGGER assignments_quota_update BEFORE UPDATE OF size, visibility ON assignments
BEGIN
  SELECT RAISE(ABORT, 'quota') WHERE NOT EXISTS (SELECT 1 FROM quota WHERE scope = NEW.owner_ref AND kind = 'assignments' AND bytes + NEW.size - OLD.size <= cap_bytes);
  SELECT RAISE(ABORT, 'quota') WHERE NEW.visibility = 'public' AND OLD.visibility <> 'public' AND NOT EXISTS (SELECT 1 FROM quota WHERE scope = 'env' AND kind = 'public_assignments' AND count < cap_count);
END;
CREATE TRIGGER assignments_quota_update_after AFTER UPDATE OF size, visibility ON assignments
BEGIN
  UPDATE quota SET bytes = bytes + NEW.size - OLD.size WHERE scope = NEW.owner_ref AND kind = 'assignments';
  UPDATE quota SET count = count + (CASE WHEN NEW.visibility = 'public' THEN 1 ELSE 0 END) - (CASE WHEN OLD.visibility = 'public' THEN 1 ELSE 0 END),
    bytes = bytes + (CASE WHEN NEW.visibility = 'public' THEN NEW.size ELSE 0 END) - (CASE WHEN OLD.visibility = 'public' THEN OLD.size ELSE 0 END)
    WHERE scope = 'env' AND kind = 'public_assignments';
END;
-- (the owner is immutable, as for registrations)
CREATE TRIGGER assignments_owner_immutable BEFORE UPDATE OF owner_ref ON assignments WHEN NEW.owner_ref <> OLD.owner_ref
BEGIN
  SELECT RAISE(ABORT, 'owner_immutable');
END;
