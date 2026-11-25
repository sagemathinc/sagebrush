-- The fleet database (FLEET_DB), part 2: what the first writers need (writers design W2 r4.2: the chain append,
-- pairing and revocation). STRICT, NOT NULL and CHECKed as part 1; every new key includes the fleet.

-- (each chain entry's signed-bytes hash, so a widening batch can compare the exact head it was verified against)
CREATE TABLE fleet_chain_hashes (
  fleet TEXT NOT NULL CHECK (length(fleet) = 26 AND fleet NOT GLOB '*[^a-z2-7]*'),
  seq INTEGER NOT NULL CHECK (seq BETWEEN 0 AND 9007199254740991),
  hash TEXT NOT NULL CHECK (length(hash) = 43 AND hash NOT GLOB '*[^A-Za-z0-9_-]*'),
  PRIMARY KEY (fleet, seq)
) STRICT;

-- (the certificate a host id was paired with: only that certificate, byte for byte, may be presented again)
CREATE TABLE fleet_host_certs (
  fleet TEXT NOT NULL CHECK (length(fleet) = 26 AND fleet NOT GLOB '*[^a-z2-7]*'),
  host TEXT NOT NULL CHECK (length(host) = 26 AND host NOT GLOB '*[^a-z2-7]*'),
  cert TEXT NOT NULL CHECK (length(cert) = 43 AND cert NOT GLOB '*[^A-Za-z0-9_-]*'),
  PRIMARY KEY (fleet, host)
) STRICT;

-- (every revocation ever applied, durable for an id not seen yet: nothing ever un-revokes)
CREATE TABLE fleet_revocations (
  fleet TEXT NOT NULL CHECK (length(fleet) = 26 AND fleet NOT GLOB '*[^a-z2-7]*'),
  kind TEXT NOT NULL CHECK (kind IN ('host', 'agent')),
  id TEXT NOT NULL CHECK (length(id) = 26 AND id NOT GLOB '*[^a-z2-7]*'),
  PRIMARY KEY (fleet, kind, id)
) STRICT;
