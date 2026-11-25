-- The fleet database (FLEET_DB), part 1: what the execution-lease decision reads and writes (fleet Worker design r1.6
-- §2). STRICT tables; every boolean, clock, generation and every column a decision or the first-lease gate reads is
-- NOT NULL as well as CHECKed (a CHECK alone admits NULL); every clock, generation and count is within
-- [0, 2^53 - 1], where D1's JavaScript API is exact; ids, hashes and nonces are checked for their exact form.

-- (a host's current pairing: its fleet, its certified signing key and its certificate's fingerprint)
CREATE TABLE fleet_hosts (
  host TEXT PRIMARY KEY NOT NULL CHECK (length(host) = 26 AND host NOT GLOB '*[^a-z2-7]*'),
  fleet TEXT NOT NULL CHECK (length(fleet) = 26 AND fleet NOT GLOB '*[^a-z2-7]*'),
  sign_key TEXT NOT NULL CHECK (length(sign_key) = 43 AND sign_key NOT GLOB '*[^A-Za-z0-9_-]*'),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 43 AND fingerprint NOT GLOB '*[^A-Za-z0-9_-]*'),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
) STRICT;

-- (an agent's binding: the one host it is bound to, and the service's entry_gen(agent, host) there)
CREATE TABLE fleet_agents (
  agent TEXT PRIMARY KEY NOT NULL CHECK (length(agent) = 26 AND agent NOT GLOB '*[^a-z2-7]*'),
  fleet TEXT NOT NULL CHECK (length(fleet) = 26 AND fleet NOT GLOB '*[^a-z2-7]*'),
  host TEXT NOT NULL CHECK (length(host) = 26 AND host NOT GLOB '*[^a-z2-7]*'),
  entry_gen INTEGER NOT NULL CHECK (entry_gen BETWEEN 1 AND 9007199254740991),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
) STRICT;

-- (a fleet's device chain, entry by entry: replayed by the core on every read, never cached)
CREATE TABLE fleet_chain_entries (
  fleet TEXT NOT NULL CHECK (length(fleet) = 26 AND fleet NOT GLOB '*[^a-z2-7]*'),
  seq INTEGER NOT NULL CHECK (seq BETWEEN 0 AND 9007199254740991),
  bytes TEXT NOT NULL CHECK (length(bytes) BETWEEN 1 AND 65536),
  PRIMARY KEY (fleet, seq)
) STRICT;

-- (a moved agent's first lease on to_host, still pending: one per agent; acked only by a verified fence ack for THIS
-- transfer, recorded in the transfer's own serialization)
CREATE TABLE lease_pending (
  agent TEXT PRIMARY KEY NOT NULL CHECK (length(agent) = 26 AND agent NOT GLOB '*[^a-z2-7]*'),
  from_host TEXT NOT NULL CHECK (length(from_host) = 26 AND from_host NOT GLOB '*[^a-z2-7]*'),
  to_host TEXT NOT NULL CHECK (length(to_host) = 26 AND to_host NOT GLOB '*[^a-z2-7]*'),
  transfer TEXT NOT NULL CHECK (length(transfer) = 43 AND transfer NOT GLOB '*[^A-Za-z0-9_-]*'),
  acked INTEGER NOT NULL DEFAULT 0 CHECK (acked IN (0, 1))
) STRICT;

-- (every authenticated request's nonce, spent whatever its outcome; decided is NULL only inside the issuing batch)
CREATE TABLE lease_nonces (
  host TEXT NOT NULL CHECK (length(host) = 26 AND host NOT GLOB '*[^a-z2-7]*'),
  nonce TEXT NOT NULL CHECK (length(nonce) = 22 AND nonce NOT GLOB '*[^A-Za-z0-9_-]*'),
  lease_id TEXT NOT NULL CHECK (length(lease_id) = 26 AND lease_id NOT GLOB '*[^a-z2-7]*'),
  decided TEXT CHECK (decided IN ('ok', 'unknown_host', 'host_revoked', 'agent_revoked', 'not_granted', 'stale_generation')),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (host, nonce)
) STRICT;

-- (the grant clock, per (agent, host): the max expiry ever granted there; never deleted while it can gate a move)
CREATE TABLE lease_clock (
  agent TEXT NOT NULL CHECK (length(agent) = 26 AND agent NOT GLOB '*[^a-z2-7]*'),
  host TEXT NOT NULL CHECK (length(host) = 26 AND host NOT GLOB '*[^a-z2-7]*'),
  expires_at INTEGER NOT NULL CHECK (expires_at BETWEEN 0 AND 9007199254740991),
  lease_id TEXT NOT NULL CHECK (length(lease_id) = 26 AND lease_id NOT GLOB '*[^a-z2-7]*'),
  gen INTEGER NOT NULL CHECK (gen BETWEEN 1 AND 9007199254740991),
  request TEXT NOT NULL CHECK (length(request) = 43 AND request NOT GLOB '*[^A-Za-z0-9_-]*'),
  PRIMARY KEY (agent, host)
) STRICT;

-- (the rate buckets: one row per allowed hit, so "at most n in ANY window of w ms" holds exactly)
CREATE TABLE fleet_bucket_hits (
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  t INTEGER NOT NULL CHECK (t BETWEEN 0 AND 9007199254740991),
  id TEXT NOT NULL CHECK (length(id) = 26),
  PRIMARY KEY (key, t, id)
) STRICT;
