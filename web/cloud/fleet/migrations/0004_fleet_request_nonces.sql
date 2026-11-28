-- The fleet database (FLEET_DB), part 4: the nonces of a host's signed reads (the chain read, chain-read note r1.2
-- §1.2). lease_nonces can't hold them: its rows carry a lease decision. STRICT, NOT NULL and CHECKed as parts 1-3
-- (byte-exact, NUL-free); the key includes the fleet.

-- (each accepted read's nonce, kept 10 minutes (r2.5 §5.3); a request's 5-minute window refuses it after that)
CREATE TABLE fleet_request_nonces (
  fleet TEXT NOT NULL CHECK (length(CAST(fleet AS BLOB)) = 26 AND instr(fleet, char(0)) = 0 AND fleet NOT GLOB '*[^a-z2-7]*'),
  host TEXT NOT NULL CHECK (length(CAST(host AS BLOB)) = 26 AND instr(host, char(0)) = 0 AND host NOT GLOB '*[^a-z2-7]*'),
  nonce TEXT NOT NULL CHECK (length(CAST(nonce AS BLOB)) = 22 AND instr(nonce, char(0)) = 0 AND nonce NOT GLOB '*[^A-Za-z0-9_-]*'),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (fleet, host, nonce)
) STRICT;
