-- The fleet database (FLEET_DB), part 3: what the grant-with-transfers writer and the fence ack need (writers design W2
-- r4.2, W2b). STRICT, NOT NULL and CHECKed as parts 1 and 2 (every text bound in stored bytes, every text column
-- NUL-free); every new key includes the fleet.

-- (each grant the service accepted, by host and generation: the latest is the host's current grant)
CREATE TABLE fleet_grants (
  fleet TEXT NOT NULL CHECK (length(CAST(fleet AS BLOB)) = 26 AND instr(fleet, char(0)) = 0 AND fleet NOT GLOB '*[^a-z2-7]*'),
  host TEXT NOT NULL CHECK (length(CAST(host AS BLOB)) = 26 AND instr(host, char(0)) = 0 AND host NOT GLOB '*[^a-z2-7]*'),
  gen INTEGER NOT NULL CHECK (gen BETWEEN 1 AND 9007199254740991),
  hash TEXT NOT NULL CHECK (length(CAST(hash AS BLOB)) = 43 AND instr(hash, char(0)) = 0 AND hash NOT GLOB '*[^A-Za-z0-9_-]*'),
  bytes TEXT NOT NULL CHECK (length(CAST(bytes AS BLOB)) BETWEEN 1 AND 65536 AND instr(bytes, char(0)) = 0),
  PRIMARY KEY (fleet, host, gen)
) STRICT;

-- (each applied transfer, kept for the fleet's life: its nonce is spent, and the fence ack reads from_gen and applied_ms:
-- the old host's entry_gen read before the rebinding, and the applying batch's own time)
CREATE TABLE fleet_transfers (
  fleet TEXT NOT NULL CHECK (length(CAST(fleet AS BLOB)) = 26 AND instr(fleet, char(0)) = 0 AND fleet NOT GLOB '*[^a-z2-7]*'),
  nonce TEXT NOT NULL CHECK (length(CAST(nonce AS BLOB)) = 22 AND instr(nonce, char(0)) = 0 AND nonce NOT GLOB '*[^A-Za-z0-9_-]*'),
  agent TEXT NOT NULL CHECK (length(CAST(agent AS BLOB)) = 26 AND instr(agent, char(0)) = 0 AND agent NOT GLOB '*[^a-z2-7]*'),
  from_host TEXT NOT NULL CHECK (length(CAST(from_host AS BLOB)) = 26 AND instr(from_host, char(0)) = 0 AND from_host NOT GLOB '*[^a-z2-7]*'),
  from_gen INTEGER NOT NULL CHECK (from_gen BETWEEN 1 AND 9007199254740991),
  to_host TEXT NOT NULL CHECK (length(CAST(to_host AS BLOB)) = 26 AND instr(to_host, char(0)) = 0 AND to_host NOT GLOB '*[^a-z2-7]*'),
  gen INTEGER NOT NULL CHECK (gen BETWEEN 1 AND 9007199254740991),
  transfer TEXT NOT NULL CHECK (length(CAST(transfer AS BLOB)) = 43 AND instr(transfer, char(0)) = 0 AND transfer NOT GLOB '*[^A-Za-z0-9_-]*'),
  receipt TEXT NOT NULL CHECK (length(CAST(receipt AS BLOB)) BETWEEN 1 AND 65536 AND instr(receipt, char(0)) = 0),
  applied_ms INTEGER NOT NULL CHECK (applied_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (fleet, nonce),
  UNIQUE (fleet, transfer)
) STRICT;

-- (an applied request's answer: the exact { transfer, receipt } envelope pairs, served byte for byte to an identical
-- retry. request_key, the sorted transfer hashes, is only a lookup; grant and transfers are compared in full. At most
-- 64 schema-bounded pairs, so well under the 1 MiB the writer and this CHECK allow, and under D1's row limit)
CREATE TABLE fleet_transfer_results (
  fleet TEXT NOT NULL CHECK (length(CAST(fleet AS BLOB)) = 26 AND instr(fleet, char(0)) = 0 AND fleet NOT GLOB '*[^a-z2-7]*'),
  request_key TEXT NOT NULL CHECK (length(CAST(request_key AS BLOB)) BETWEEN 43 AND 2815 AND instr(request_key, char(0)) = 0 AND request_key NOT GLOB '*[^A-Za-z0-9_,-]*'),
  grant_hash TEXT NOT NULL CHECK (length(CAST(grant_hash AS BLOB)) = 43 AND instr(grant_hash, char(0)) = 0 AND grant_hash NOT GLOB '*[^A-Za-z0-9_-]*'),
  transfers TEXT NOT NULL CHECK (length(CAST(transfers AS BLOB)) BETWEEN 43 AND 2815 AND instr(transfers, char(0)) = 0 AND transfers NOT GLOB '*[^A-Za-z0-9_,-]*'),
  result TEXT NOT NULL CHECK (length(CAST(result AS BLOB)) BETWEEN 2 AND 1048576 AND instr(result, char(0)) = 0),
  PRIMARY KEY (fleet, request_key)
) STRICT;

-- (an agent a grant dropped from its own host: deprovisioned, never listed again)
CREATE TABLE fleet_retired_agents (
  fleet TEXT NOT NULL CHECK (length(CAST(fleet AS BLOB)) = 26 AND instr(fleet, char(0)) = 0 AND fleet NOT GLOB '*[^a-z2-7]*'),
  agent TEXT NOT NULL CHECK (length(CAST(agent AS BLOB)) = 26 AND instr(agent, char(0)) = 0 AND agent NOT GLOB '*[^a-z2-7]*'),
  PRIMARY KEY (fleet, agent)
) STRICT;

-- (the one accepted fence ack of each transfer)
CREATE TABLE fleet_fence_acks (
  fleet TEXT NOT NULL CHECK (length(CAST(fleet AS BLOB)) = 26 AND instr(fleet, char(0)) = 0 AND fleet NOT GLOB '*[^a-z2-7]*'),
  transfer TEXT NOT NULL CHECK (length(CAST(transfer AS BLOB)) = 43 AND instr(transfer, char(0)) = 0 AND transfer NOT GLOB '*[^A-Za-z0-9_-]*'),
  PRIMARY KEY (fleet, transfer)
) STRICT;

-- (what the old host reads on its service channel: a transfer of one of its agents; its reader is a later route)
CREATE TABLE fleet_host_queue (
  fleet TEXT NOT NULL CHECK (length(CAST(fleet AS BLOB)) = 26 AND instr(fleet, char(0)) = 0 AND fleet NOT GLOB '*[^a-z2-7]*'),
  host TEXT NOT NULL CHECK (length(CAST(host AS BLOB)) = 26 AND instr(host, char(0)) = 0 AND host NOT GLOB '*[^a-z2-7]*'),
  kind TEXT NOT NULL CHECK (kind IN ('transfer')),
  ref TEXT NOT NULL CHECK (length(CAST(ref AS BLOB)) = 43 AND instr(ref, char(0)) = 0 AND ref NOT GLOB '*[^A-Za-z0-9_-]*'),
  at_ms INTEGER NOT NULL CHECK (at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (fleet, host, kind, ref)
) STRICT;

-- (one grant decision in flight: the batch's decision row, set by its first failing check and deleted by its last
-- statement, so it never outlives the batch)
CREATE TABLE fleet_grant_decisions (
  request TEXT PRIMARY KEY NOT NULL CHECK (length(CAST(request AS BLOB)) = 26 AND instr(request, char(0)) = 0 AND request NOT GLOB '*[^a-z2-7]*'),
  decided TEXT CHECK (decided IN ('ok', 'retry', 'moved', 'replay', 'bad_form', 'not_granted', 'agent_revoked', 'unknown_host', 'host_revoked',
    'stale_generation', 'in_progress'))
) STRICT;

-- (the SHA-256 of the agent's current grant entry, so a generation moves entry_gen only for an entry that changed.
-- No writer has stored a binding before this migration; '' never equals a digest, so such a row would count as changed)
ALTER TABLE fleet_agents ADD COLUMN entry TEXT NOT NULL DEFAULT '' CHECK (entry = '' OR (length(CAST(entry AS BLOB)) = 43 AND instr(entry, char(0)) = 0 AND entry NOT GLOB '*[^A-Za-z0-9_-]*'));
