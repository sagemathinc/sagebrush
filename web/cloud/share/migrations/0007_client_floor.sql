-- The force-reload floors (plan force-reload r7.2 §2; cloud PR A census r3 §4): the reload floor R and the
-- compat floor C, one row each.  `c` is the floor's value.  The compat row also carries its publication state:
-- a Raise sets c, bumps epoch and makes it 'pending' with no set_at (one statement); a Finalize of that epoch
-- makes it 'final' and stamps set_at with D1's own clock, unixepoch('subsec'), in SECONDS.  C is never lowered
-- by the API; nothing here writes a client's data.  Only a new table: no existing table is touched.
CREATE TABLE client_floor (
  kind TEXT PRIMARY KEY CHECK (kind IN ('reload', 'compat')),
  c INTEGER NOT NULL DEFAULT 0 CHECK (c >= 0 AND c <= 2147483647),
  epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  state TEXT NOT NULL DEFAULT 'final' CHECK (state IN ('pending', 'final')),
  set_at REAL
);
INSERT INTO client_floor (kind) VALUES ('reload'), ('compat');
