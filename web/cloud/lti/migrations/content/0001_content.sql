-- LtiContent (plan-lti-r5 amendment 3 r15, 092db4a7): assignments, their
-- revisions, the bundles they hold, and the pins that keep revisions alive.
-- A D1 of its own per environment (§2.3).  Admission is constant work: quota
-- rows maintained by triggers, so a cap check, its row and its counter commit
-- or fail together; a missing quota row aborts (fails closed).  The caps are
-- the quota rows' cap columns: admin-configurable defaults, within the hard
-- ranges of quota_hard (below).

-- D1's own clock, in ms, as every time test here reads it
-- (julianday('now') is the statement's time, the same within a statement).

CREATE TABLE quota (
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  cap_count INTEGER NOT NULL,
  cap_bytes INTEGER NOT NULL,
  PRIMARY KEY (scope, kind)
) WITHOUT ROWID;

-- The hard ceilings an admin's cap can never exceed (a cap is a default, not a blank cheque).
CREATE TABLE quota_hard (kind TEXT PRIMARY KEY, max_count INTEGER NOT NULL, max_bytes INTEGER NOT NULL) WITHOUT ROWID;
INSERT INTO quota_hard (kind, max_count, max_bytes) VALUES
  ('owners', 100, 0),
  ('public_assignments', 10000, 0),
  ('env_bundles', 2010000, 536870912000),
  ('assignments', 2000, 0),
  ('revisions', 20000, 0),
  ('bundles', 20100, 5368709120),
  ('placement_pins', 10000, 0),
  ('dl_pins', 10000, 0);
CREATE TRIGGER quota_hard_insert BEFORE INSERT ON quota
BEGIN
  SELECT RAISE(ABORT, 'cap_range') WHERE NOT EXISTS (SELECT 1 FROM quota_hard WHERE kind = NEW.kind AND NEW.cap_count <= max_count AND NEW.cap_bytes <= max_bytes);
END;
CREATE TRIGGER quota_hard_update BEFORE UPDATE OF cap_count, cap_bytes ON quota
BEGIN
  SELECT RAISE(ABORT, 'cap_range') WHERE NOT EXISTS (SELECT 1 FROM quota_hard WHERE kind = NEW.kind AND NEW.cap_count <= max_count AND NEW.cap_bytes <= max_bytes);
END;

-- The environment's own quota rows; an owner's are made with its owners row, a registration's with its first pin.
INSERT INTO quota (scope, kind, cap_count, cap_bytes) VALUES
  ('env', 'owners', 100, 0),
  ('env', 'public_assignments', 10000, 0),
  ('env', 'env_bundles', 2010000, 536870912000);

-- §2.5: `valid_cycle` (usable is derived from it); 0 until a recovery.
CREATE TABLE meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL) WITHOUT ROWID;
INSERT INTO meta (k, v) VALUES ('valid_cycle', 0);

-- ---- owners: one quota row per owner (§2.3), ≤ 100 per environment
CREATE TABLE owners (owner_ref TEXT PRIMARY KEY CHECK (length(CAST(owner_ref AS BLOB)) BETWEEN 1 AND 64), created INTEGER NOT NULL) WITHOUT ROWID;
-- (checks BEFORE, guarded so an INSERT OR IGNORE of an existing row passes; counts AFTER, which fires only
-- for a row really inserted: SQLite runs BEFORE INSERT triggers even when the insert is then ignored)
CREATE TRIGGER owners_insert BEFORE INSERT ON owners WHEN NOT EXISTS (SELECT 1 FROM owners WHERE owner_ref = NEW.owner_ref)
BEGIN
  SELECT RAISE(ABORT, 'quota') WHERE NOT EXISTS (SELECT 1 FROM quota WHERE scope = 'env' AND kind = 'owners' AND count < cap_count);
END;
CREATE TRIGGER owners_inserted AFTER INSERT ON owners
BEGIN
  UPDATE quota SET count = count + 1 WHERE scope = 'env' AND kind = 'owners';
  INSERT INTO quota (scope, kind, cap_count, cap_bytes) VALUES (NEW.owner_ref, 'assignments', 2000, 0), (NEW.owner_ref, 'revisions', 20000, 0), (NEW.owner_ref, 'bundles', 20100, 5368709120);
END;
CREATE TRIGGER owners_immutable BEFORE UPDATE ON owners
BEGIN
  SELECT RAISE(ABORT, 'owner_immutable');
END;

-- ---- assignments (§1, §3): the current state; ≤ 2,000 per owner, a public catalog ≤ 10,000
CREATE TABLE assignments (
  aid TEXT PRIMARY KEY CHECK (length(aid) = 32),
  owner_ref TEXT NOT NULL CHECK (length(CAST(owner_ref AS BLOB)) BETWEEN 1 AND 64),
  title TEXT NOT NULL CHECK (length(CAST(title AS BLOB)) BETWEEN 1 AND 255),
  rev INTEGER NOT NULL CHECK (rev >= 1),
  revs INTEGER NOT NULL DEFAULT 0 CHECK (revs >= 0),
  runtime_policy TEXT NOT NULL CHECK (runtime_policy IN ('browser', 'cocalc', 'either')),
  max_points REAL NOT NULL CHECK (max_points >= 0 AND max_points <= 100000),
  visibility TEXT NOT NULL CHECK (visibility IN ('institution', 'public')),
  bundle_sha TEXT NOT NULL CHECK (length(bundle_sha) = 64),
  updated INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX assignments_owner ON assignments (owner_ref);
CREATE INDEX assignments_public ON assignments (visibility) WHERE visibility = 'public';
CREATE TRIGGER assignments_insert BEFORE INSERT ON assignments
BEGIN
  SELECT RAISE(ABORT, 'quota') WHERE NOT EXISTS (SELECT 1 FROM quota WHERE scope = NEW.owner_ref AND kind = 'assignments' AND count < cap_count);
  SELECT RAISE(ABORT, 'quota') WHERE NEW.visibility = 'public' AND NOT EXISTS (SELECT 1 FROM quota WHERE scope = 'env' AND kind = 'public_assignments' AND count < cap_count);
END;
CREATE TRIGGER assignments_inserted AFTER INSERT ON assignments
BEGIN
  UPDATE quota SET count = count + 1 WHERE scope = NEW.owner_ref AND kind = 'assignments';
  UPDATE quota SET count = count + 1 WHERE scope = 'env' AND kind = 'public_assignments' AND NEW.visibility = 'public';
END;
CREATE TRIGGER assignments_delete AFTER DELETE ON assignments
BEGIN
  UPDATE quota SET count = count - 1 WHERE scope = OLD.owner_ref AND kind = 'assignments';
  UPDATE quota SET count = count - 1 WHERE scope = 'env' AND kind = 'public_assignments' AND OLD.visibility = 'public';
END;
CREATE TRIGGER assignments_owner_immutable BEFORE UPDATE OF owner_ref, aid ON assignments
BEGIN
  SELECT RAISE(ABORT, 'owner_immutable') WHERE NEW.owner_ref <> OLD.owner_ref OR NEW.aid <> OLD.aid;
END;
CREATE TRIGGER assignments_publish BEFORE UPDATE OF visibility ON assignments WHEN NEW.visibility = 'public' AND OLD.visibility <> 'public'
BEGIN
  SELECT RAISE(ABORT, 'quota') WHERE NOT EXISTS (SELECT 1 FROM quota WHERE scope = 'env' AND kind = 'public_assignments' AND count < cap_count);
END;
CREATE TRIGGER assignments_visibility AFTER UPDATE OF visibility ON assignments WHEN NEW.visibility <> OLD.visibility
BEGIN
  UPDATE quota SET count = count + (CASE WHEN NEW.visibility = 'public' THEN 1 ELSE -1 END) WHERE scope = 'env' AND kind = 'public_assignments';
END;

-- ---- bundles (§2.1–§2.4): the LTI-owned copy's state machine; one row per (owner, sha)
CREATE TABLE bundles (
  owner_ref TEXT NOT NULL CHECK (length(CAST(owner_ref AS BLOB)) BETWEEN 1 AND 64),
  sha TEXT NOT NULL CHECK (length(sha) = 64),
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 26214400),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'held', 'releasing')),
  token TEXT NOT NULL UNIQUE CHECK (length(token) = 32),
  deadline INTEGER NOT NULL,
  held_at INTEGER,
  refs INTEGER NOT NULL DEFAULT 0 CHECK (refs >= 0),
  due INTEGER,
  tries INTEGER NOT NULL DEFAULT 0,
  seen_cycle INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_ref, sha)
) WITHOUT ROWID;
CREATE INDEX bundles_due ON bundles (due) WHERE due IS NOT NULL;
-- (a reserve is INSERT … ON CONFLICT DO NOTHING: an existing (owner, sha) row answers instead, charged nothing)
CREATE TRIGGER bundles_insert BEFORE INSERT ON bundles WHEN NOT EXISTS (SELECT 1 FROM bundles WHERE owner_ref = NEW.owner_ref AND sha = NEW.sha)
BEGIN
  SELECT RAISE(ABORT, 'bundle_quota') WHERE NEW.state <> 'reserved' OR NEW.refs <> 0;
  SELECT RAISE(ABORT, 'bundle_quota') WHERE NOT EXISTS (SELECT 1 FROM quota WHERE scope = NEW.owner_ref AND kind = 'bundles' AND count < cap_count AND bytes + NEW.size <= cap_bytes);
  SELECT RAISE(ABORT, 'bundle_quota') WHERE NOT EXISTS (SELECT 1 FROM quota WHERE scope = 'env' AND kind = 'env_bundles' AND count < cap_count AND bytes + NEW.size <= cap_bytes);
END;
CREATE TRIGGER bundles_inserted AFTER INSERT ON bundles
BEGIN
  UPDATE quota SET count = count + 1, bytes = bytes + NEW.size WHERE scope = NEW.owner_ref AND kind = 'bundles';
  UPDATE quota SET count = count + 1, bytes = bytes + NEW.size WHERE scope = 'env' AND kind = 'env_bundles';
END;
-- (the charge comes back only when the row goes, which is only after its R2 object has gone, §2.4)
CREATE TRIGGER bundles_delete AFTER DELETE ON bundles
BEGIN
  UPDATE quota SET count = count - 1, bytes = bytes - OLD.size WHERE scope = OLD.owner_ref AND kind = 'bundles';
  UPDATE quota SET count = count - 1, bytes = bytes - OLD.size WHERE scope = 'env' AND kind = 'env_bundles';
END;
-- (a row's object key o/<owner digest>/<sha>/<token> never changes)
CREATE TRIGGER bundles_immutable BEFORE UPDATE OF owner_ref, sha, size, token ON bundles
BEGIN
  SELECT RAISE(ABORT, 'owner_immutable') WHERE NEW.owner_ref <> OLD.owner_ref OR NEW.sha <> OLD.sha OR NEW.size <> OLD.size OR NEW.token <> OLD.token;
END;
-- (only forward: reserved → held → releasing; a releasing row is never re-held)
CREATE TRIGGER bundles_forward BEFORE UPDATE OF state ON bundles WHEN NEW.state <> OLD.state
BEGIN
  SELECT RAISE(ABORT, 'bundle_state') WHERE NOT ((OLD.state = 'reserved' AND NEW.state = 'held') OR (OLD.state = 'held' AND NEW.state = 'releasing'));
END;

-- ---- assignment_revisions (§3): every revision kept; each holds its bundle (§2.3)
CREATE TABLE assignment_revisions (
  aid TEXT NOT NULL CHECK (length(aid) = 32),
  rev INTEGER NOT NULL CHECK (rev >= 1),
  owner_ref TEXT NOT NULL CHECK (length(CAST(owner_ref AS BLOB)) BETWEEN 1 AND 64),
  bundle_sha TEXT NOT NULL CHECK (length(bundle_sha) = 64),
  runtime_policy TEXT NOT NULL CHECK (runtime_policy IN ('browser', 'cocalc', 'either')),
  max_points REAL NOT NULL CHECK (max_points >= 0 AND max_points <= 100000),
  created INTEGER NOT NULL,
  PRIMARY KEY (aid, rev)
) WITHOUT ROWID;
CREATE TRIGGER revisions_insert BEFORE INSERT ON assignment_revisions
BEGIN
  -- (CORR-LTI5A3-1: only the batch whose CAS just made `rev` current may write it)
  SELECT RAISE(ABORT, 'stale_rev') WHERE NOT EXISTS (SELECT 1 FROM assignments WHERE aid = NEW.aid AND owner_ref = NEW.owner_ref AND rev = NEW.rev);
  -- (the bundle held and usable: seen at or after the current valid cycle, §2.5)
  SELECT RAISE(ABORT, 'no_bundle') WHERE NOT EXISTS (SELECT 1 FROM bundles WHERE owner_ref = NEW.owner_ref AND sha = NEW.bundle_sha AND state = 'held' AND seen_cycle >= (SELECT v FROM meta WHERE k = 'valid_cycle'));
  SELECT RAISE(ABORT, 'quota') WHERE (SELECT revs FROM assignments WHERE aid = NEW.aid) >= 100;
  SELECT RAISE(ABORT, 'quota') WHERE NOT EXISTS (SELECT 1 FROM quota WHERE scope = NEW.owner_ref AND kind = 'revisions' AND count < cap_count);
END;
CREATE TRIGGER revisions_inserted AFTER INSERT ON assignment_revisions
BEGIN
  UPDATE bundles SET refs = refs + 1, due = NULL WHERE owner_ref = NEW.owner_ref AND sha = NEW.bundle_sha;
  UPDATE assignments SET revs = revs + 1 WHERE aid = NEW.aid;
  UPDATE quota SET count = count + 1 WHERE scope = NEW.owner_ref AND kind = 'revisions';
END;
CREATE TRIGGER revisions_immutable BEFORE UPDATE ON assignment_revisions
BEGIN
  SELECT RAISE(ABORT, 'owner_immutable');
END;
-- (the release rule, §2.4: never the current rev, never a pinned one)
CREATE TRIGGER revisions_delete BEFORE DELETE ON assignment_revisions
BEGIN
  SELECT RAISE(ABORT, 'pinned') WHERE EXISTS (SELECT 1 FROM assignments WHERE aid = OLD.aid AND rev = OLD.rev);
  SELECT RAISE(ABORT, 'pinned') WHERE EXISTS (SELECT 1 FROM pins WHERE aid = OLD.aid AND rev = OLD.rev);
END;
CREATE TRIGGER revisions_deleted AFTER DELETE ON assignment_revisions
BEGIN
  UPDATE bundles SET refs = refs - 1 WHERE owner_ref = OLD.owner_ref AND sha = OLD.bundle_sha;
  UPDATE bundles SET state = 'releasing', due = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE owner_ref = OLD.owner_ref AND sha = OLD.bundle_sha AND refs = 0 AND state = 'held';
  UPDATE assignments SET revs = revs - 1 WHERE aid = OLD.aid;
  UPDATE quota SET count = count - 1 WHERE scope = OLD.owner_ref AND kind = 'revisions';
END;

-- ---- pins (§4): what keeps a revision alive; ≤ 10,000 of each kind per registration
CREATE TABLE pins (
  kind TEXT NOT NULL CHECK (kind IN ('placement', 'dl')),
  rid TEXT NOT NULL CHECK (length(rid) = 32),
  item TEXT NOT NULL CHECK (length(item) BETWEEN 1 AND 64),
  aid TEXT NOT NULL CHECK (length(aid) = 32),
  rev INTEGER NOT NULL CHECK (rev >= 1),
  launch_id TEXT CHECK (launch_id IS NULL OR length(launch_id) <= 64),
  created INTEGER NOT NULL,
  PRIMARY KEY (kind, rid, item)
) WITHOUT ROWID;
CREATE INDEX pins_revision ON pins (aid, rev);
-- (the revision check on every pin write, even one the launch's ON CONFLICT DO NOTHING then ignores, §4; the cap
-- only for a row that doesn't exist yet; the count AFTER, for a row really inserted)
CREATE TRIGGER pins_insert BEFORE INSERT ON pins
BEGIN
  SELECT RAISE(ABORT, 'no_revision') WHERE NOT EXISTS (SELECT 1 FROM assignment_revisions WHERE aid = NEW.aid AND rev = NEW.rev);
  SELECT RAISE(ABORT, 'pin_quota') WHERE NOT EXISTS (SELECT 1 FROM pins WHERE kind = NEW.kind AND rid = NEW.rid AND item = NEW.item)
    AND NOT EXISTS (SELECT 1 FROM quota WHERE scope = NEW.rid AND kind = (CASE NEW.kind WHEN 'placement' THEN 'placement_pins' ELSE 'dl_pins' END) AND count < cap_count);
END;
CREATE TRIGGER pins_inserted AFTER INSERT ON pins
BEGIN
  UPDATE quota SET count = count + 1 WHERE scope = NEW.rid AND kind = (CASE NEW.kind WHEN 'placement' THEN 'placement_pins' ELSE 'dl_pins' END);
END;
CREATE TRIGGER pins_update BEFORE UPDATE ON pins
BEGIN
  SELECT RAISE(ABORT, 'no_revision') WHERE NOT EXISTS (SELECT 1 FROM assignment_revisions WHERE aid = NEW.aid AND rev = NEW.rev);
  SELECT RAISE(ABORT, 'owner_immutable') WHERE NEW.kind <> OLD.kind OR NEW.rid <> OLD.rid OR NEW.item <> OLD.item;
END;
CREATE TRIGGER pins_delete AFTER DELETE ON pins
BEGIN
  UPDATE quota SET count = count - 1 WHERE scope = OLD.rid AND kind = (CASE OLD.kind WHEN 'placement' THEN 'placement_pins' ELSE 'dl_pins' END);
END;
-- (a registration's pin quota rows are made by its first pin's batch, INSERT OR IGNORE, at the default caps)

-- ---- the call chain (§2.5, CORR-LTI5A3-3): every fenced batch's first statement
CREATE TABLE gate_calls (
  seq INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('write', 'tombstone', 'checkpoint', 'probe', 'marker')),
  deadline INTEGER,
  from_seq INTEGER,
  nonce TEXT
);
CREATE TRIGGER gate_calls_successor BEFORE INSERT ON gate_calls WHEN NEW.kind <> 'marker'
BEGIN
  SELECT RAISE(ABORT, 'not_successor') WHERE NEW.seq <> coalesce((SELECT max(seq) FROM gate_calls), 0) + 1;
  SELECT RAISE(ABORT, 'ticket_expired') WHERE NEW.kind = 'write' AND NOT (NEW.deadline > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER gate_calls_marker BEFORE INSERT ON gate_calls WHEN NEW.kind = 'marker'
BEGIN
  SELECT RAISE(ABORT, 'marker_head') WHERE NEW.from_seq IS NOT coalesce((SELECT max(seq) FROM gate_calls), 0)
    OR NOT EXISTS (SELECT 1 FROM gate_calls WHERE seq = NEW.from_seq AND kind = 'checkpoint' AND nonce = NEW.nonce)
    OR NOT (NEW.seq > NEW.from_seq);
END;
CREATE TRIGGER gate_calls_keep AFTER INSERT ON gate_calls
BEGIN
  DELETE FROM gate_calls WHERE seq <= NEW.seq - 1000;
END;

-- ---- the scan cursor and the sweep lease (§2.5; worked in A3-2)
CREATE TABLE scan (one INTEGER PRIMARY KEY CHECK (one = 1), cursor TEXT NOT NULL DEFAULT '', cycle INTEGER NOT NULL DEFAULT 0, cycle_started INTEGER NOT NULL DEFAULT 0);
INSERT INTO scan (one) VALUES (1);
CREATE TABLE sweep_lease (one INTEGER PRIMARY KEY CHECK (one = 1), until INTEGER NOT NULL DEFAULT 0);
INSERT INTO sweep_lease (one) VALUES (1);
