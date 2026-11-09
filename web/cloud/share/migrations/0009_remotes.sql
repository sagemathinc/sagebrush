-- Remotes (core design remote-v1 r1.8 §3, §13.2): a box's `sagebrush remote` (a runner) or an agent's `sagebrush-mcp
-- --remote` (an agent), enrolled by the device flow (RFC 8628 shape) and approved by a signed-in person.  web/remote.
-- DEV first; PROD only with William's per-file OK.
--
-- remotes: one enrolled peer.  Its key (jwk, its RFC 7638 thumbprint jkt) and its kind never change: re-enrolling
-- makes a new remote_id, and nothing (grants, approvals) moves from an old one.  `name` is the peer's own claim.
-- revoked: when it was revoked (seconds), or NULL.  Deleted with its account.
CREATE TABLE remotes (
  remote_id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('runner', 'agent')),
  jwk TEXT NOT NULL,
  jkt TEXT NOT NULL,
  name TEXT NOT NULL,
  created INTEGER NOT NULL,
  revoked INTEGER
);
CREATE INDEX remotes_account ON remotes (account, kind);

-- remote_devices: a device flow in progress, for at most 10 minutes: the device code only as its SHA-256, the user
-- code shown to the person, the key and kind it asked for, its state, and once approved the account and remote_id
-- (delivered once, by the poll).  Expired rows are removed as new ones are made.
CREATE TABLE remote_devices (
  device_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('runner', 'agent')),
  jwk TEXT NOT NULL,
  jkt TEXT NOT NULL,
  name TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  last_poll INTEGER,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'denied', 'delivered')),
  account TEXT,
  remote_id TEXT
);
CREATE INDEX remote_devices_expires ON remote_devices (expires);

-- remote_wrong: wrong user codes entered by an account, in a 10-minute window (5 allowed).
CREATE TABLE remote_wrong (
  account TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  since INTEGER NOT NULL
);
