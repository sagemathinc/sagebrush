-- Placements (plan-lti-r5 §1, §5.1, §15.1 as amended in r3: ≤ 10,000 per
-- registration, ≤ 1 KiB a row).  A placement holds its latest launch's AGS
-- grant; a newer launch replaces it.
CREATE TABLE placements (
  placement TEXT PRIMARY KEY CHECK (length(placement) = 32),
  rid TEXT NOT NULL CHECK (length(rid) = 32),
  deployment TEXT NOT NULL CHECK (length(CAST(deployment AS BLOB)) BETWEEN 1 AND 255),
  course TEXT NOT NULL CHECK (length(course) = 32),
  resource_link TEXT NOT NULL CHECK (length(CAST(resource_link AS BLOB)) BETWEEN 1 AND 255),
  aid TEXT CHECK (aid IS NULL OR length(aid) = 32),
  ags_scope TEXT CHECK (ags_scope IS NULL OR length(CAST(ags_scope AS BLOB)) <= 200),
  lineitems TEXT CHECK (lineitems IS NULL OR length(CAST(lineitems AS BLOB)) <= 400),
  lineitem TEXT CHECK (lineitem IS NULL OR length(CAST(lineitem AS BLOB)) <= 400),
  updated INTEGER NOT NULL,
  size INTEGER NOT NULL CHECK (size <= 1024 AND size = 32 + 32 + length(CAST(deployment AS BLOB)) + 32 + length(CAST(resource_link AS BLOB)) + 32 + coalesce(length(CAST(ags_scope AS BLOB)), 0) + coalesce(length(CAST(lineitems AS BLOB)), 0) + coalesce(length(CAST(lineitem AS BLOB)), 0) + 8 + 8)
);
CREATE INDEX placements_rid ON placements (rid);
CREATE TRIGGER placements_quota_insert BEFORE INSERT ON placements
BEGIN
  SELECT RAISE(ABORT, 'quota') WHERE NOT EXISTS (SELECT 1 FROM quota WHERE scope = NEW.rid AND kind = 'placements' AND count < cap_count AND bytes + NEW.size <= cap_bytes);
  UPDATE quota SET count = count + 1, bytes = bytes + NEW.size WHERE scope = NEW.rid AND kind = 'placements';
END;
CREATE TRIGGER placements_quota_delete AFTER DELETE ON placements
BEGIN
  UPDATE quota SET count = count - 1, bytes = bytes - OLD.size WHERE scope = OLD.rid AND kind = 'placements';
END;
CREATE TRIGGER placements_quota_size BEFORE UPDATE OF size ON placements WHEN NEW.size > OLD.size
BEGIN
  SELECT RAISE(ABORT, 'quota') WHERE NOT EXISTS (SELECT 1 FROM quota WHERE scope = NEW.rid AND kind = 'placements' AND bytes + NEW.size - OLD.size <= cap_bytes);
END;
CREATE TRIGGER placements_quota_size_after AFTER UPDATE OF size ON placements
BEGIN
  UPDATE quota SET bytes = bytes + NEW.size - OLD.size WHERE scope = NEW.rid AND kind = 'placements';
END;
-- (registrations made before this migration get their placements quota row here)
INSERT OR IGNORE INTO quota (scope, kind, cap_count, cap_bytes) SELECT rid, 'placements', 10000, 10240000 FROM registrations;
