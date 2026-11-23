-- The fleet Worker's own state for the browser relay's control plane (agent-autonomous-browser-relay.md r2.1 §3, §5).
-- Applied by hand, DEV only (README: deploy); PROD has no database until the owner's OK on this file.

-- The control calls' ids, each consumed once, kept 10 minutes past its timestamp.
CREATE TABLE relay_calls (
  id TEXT PRIMARY KEY,
  until_ms INTEGER NOT NULL
) STRICT;

-- The one monotone sequence: every recorded change takes the next value, and so does every feed answer (its cursor),
-- so a cursor always advances, even when nothing changed.  floor: the highest seq the cleanup has removed (a since
-- below it is cursor_expired).
CREATE TABLE relay_seq (
  k INTEGER PRIMARY KEY CHECK (k = 1),
  n INTEGER NOT NULL,
  floor INTEGER NOT NULL
) STRICT;
INSERT INTO relay_seq (k, n, floor) VALUES (1, 0, 0);

-- Each identity's current epoch (kind: 'agent', 'account' or 'host'); an identity never listed is at 0.
CREATE TABLE relay_epochs (
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'account', 'host')),
  id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
) STRICT;

-- The changes, in seq order, kept 24 hours.
CREATE TABLE relay_changes (
  seq INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'account', 'host')),
  id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  at_ms INTEGER NOT NULL
) STRICT;
