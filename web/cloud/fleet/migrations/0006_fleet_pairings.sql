-- The fleet database (FLEET_DB), part 6: host pairing (the pairing service note d3). STRICT, NOT NULL where a value is
-- always present, and CHECKed as parts 1-5 (every text bound in stored bytes, every text column NUL-free).

-- (one row per host id's pairing attempt. The code is kept only as its SHA-256, and cleared once the pairing expires:
-- the row then stays as a tombstone, so a re-POST or a poll for that host id keeps answering "expired" (P2). An
-- approved pairing has no stored state: it is approved when its host's certificate stands (fleet_host_certs))
CREATE TABLE fleet_pairings (
  pairing TEXT PRIMARY KEY NOT NULL CHECK (length(CAST(pairing AS BLOB)) = 26 AND instr(pairing, char(0)) = 0 AND pairing NOT GLOB '*[^a-z2-7]*'),
  code_hash TEXT UNIQUE CHECK (code_hash IS NULL OR (length(CAST(code_hash AS BLOB)) = 43 AND instr(code_hash, char(0)) = 0 AND code_hash NOT GLOB '*[^A-Za-z0-9_-]*')),
  host TEXT NOT NULL UNIQUE CHECK (length(CAST(host AS BLOB)) = 26 AND instr(host, char(0)) = 0 AND host NOT GLOB '*[^a-z2-7]*'),
  sign_key TEXT NOT NULL CHECK (length(CAST(sign_key AS BLOB)) = 43 AND instr(sign_key, char(0)) = 0 AND sign_key NOT GLOB '*[^A-Za-z0-9_-]*'),
  enc_key TEXT NOT NULL CHECK (length(CAST(enc_key AS BLOB)) = 43 AND instr(enc_key, char(0)) = 0 AND enc_key NOT GLOB '*[^A-Za-z0-9_-]*'),
  fingerprint TEXT NOT NULL CHECK (length(CAST(fingerprint AS BLOB)) = 43 AND instr(fingerprint, char(0)) = 0 AND fingerprint NOT GLOB '*[^A-Za-z0-9_-]*'),
  name TEXT NOT NULL CHECK (length(CAST(name AS BLOB)) BETWEEN 1 AND 32 AND instr(name, char(0)) = 0 AND name NOT GLOB '*[^a-z0-9-]*'),
  source TEXT NOT NULL CHECK (length(CAST(source AS BLOB)) BETWEEN 1 AND 64 AND instr(source, char(0)) = 0),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  expires_ms INTEGER NOT NULL CHECK (expires_ms BETWEEN 0 AND 9007199254740991),
  -- (the single-winner claim on an approve (P1): a claim id, the claiming account, and the lease's end; all NULL or none)
  claim TEXT CHECK (claim IS NULL OR (length(CAST(claim AS BLOB)) = 26 AND instr(claim, char(0)) = 0 AND claim NOT GLOB '*[^a-z2-7]*')),
  claim_account TEXT CHECK (claim_account IS NULL OR (length(CAST(claim_account AS BLOB)) BETWEEN 1 AND 64 AND instr(claim_account, char(0)) = 0 AND claim_account NOT GLOB '*[^A-Za-z0-9_-]*')),
  claim_until_ms INTEGER CHECK (claim_until_ms IS NULL OR claim_until_ms BETWEEN 0 AND 9007199254740991),
  -- (the fleet a successful claim certified the host into, recorded at its release)
  fleet TEXT CHECK (fleet IS NULL OR (length(CAST(fleet AS BLOB)) = 26 AND instr(fleet, char(0)) = 0 AND fleet NOT GLOB '*[^a-z2-7]*')),
  CHECK ((claim IS NULL) = (claim_account IS NULL) AND (claim IS NULL) = (claim_until_ms IS NULL))
) STRICT;

-- (every approval id spent on a claim, whether or not its pairing then certified the host: an approval is single-use)
CREATE TABLE fleet_pairing_approvals (
  approval TEXT PRIMARY KEY NOT NULL CHECK (length(CAST(approval AS BLOB)) = 26 AND instr(approval, char(0)) = 0 AND approval NOT GLOB '*[^a-z2-7]*'),
  pairing TEXT NOT NULL CHECK (length(CAST(pairing AS BLOB)) = 26 AND instr(pairing, char(0)) = 0 AND pairing NOT GLOB '*[^a-z2-7]*'),
  account TEXT NOT NULL CHECK (length(CAST(account AS BLOB)) BETWEEN 1 AND 64 AND instr(account, char(0)) = 0 AND account NOT GLOB '*[^A-Za-z0-9_-]*'),
  at_ms INTEGER NOT NULL CHECK (at_ms BETWEEN 0 AND 9007199254740991)
) STRICT;

-- (the nonces of an unpaired host's signed pairing requests: it has no fleet yet, so they can't go in
-- fleet_request_nonces. Kept 10 minutes; a request's 5-minute window refuses it after that)
CREATE TABLE fleet_pairing_nonces (
  host TEXT NOT NULL CHECK (length(CAST(host AS BLOB)) = 26 AND instr(host, char(0)) = 0 AND host NOT GLOB '*[^a-z2-7]*'),
  nonce TEXT NOT NULL CHECK (length(CAST(nonce AS BLOB)) = 22 AND instr(nonce, char(0)) = 0 AND nonce NOT GLOB '*[^A-Za-z0-9_-]*'),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (host, nonce)
) STRICT;
