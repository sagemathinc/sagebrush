-- The fleet database (FLEET_DB), part 5: what the person's reads need (the reads scope r4 §1, §3.1, §4). STRICT, NOT
-- NULL and CHECKed as parts 1-4 (every text bound in stored bytes, every text column NUL-free).

-- (who owns a fleet: written once, by the genesis append under the person's session, never rebound; one fleet per
-- account. The account id is the site's account id: ASCII [A-Za-z0-9_-], at most 64 bytes)
CREATE TABLE fleet_accounts (
  fleet TEXT PRIMARY KEY NOT NULL CHECK (length(CAST(fleet AS BLOB)) = 26 AND instr(fleet, char(0)) = 0 AND fleet NOT GLOB '*[^a-z2-7]*'),
  account TEXT NOT NULL UNIQUE CHECK (length(CAST(account AS BLOB)) BETWEEN 1 AND 64 AND instr(account, char(0)) = 0 AND account NOT GLOB '*[^A-Za-z0-9_-]*')
) STRICT;

-- (the exact signed text of each pairing's certificate and of each host's first revocation, so the page verifies them
-- itself. No writer has stored a row before this migration, so the DEFAULT is never kept: every insert writes the text,
-- and the CHECK refuses an empty one)
ALTER TABLE fleet_host_certs ADD COLUMN bytes TEXT NOT NULL DEFAULT '' CHECK (length(CAST(bytes AS BLOB)) BETWEEN 1 AND 65536 AND instr(bytes, char(0)) = 0);
ALTER TABLE fleet_revocations ADD COLUMN bytes TEXT NOT NULL DEFAULT '' CHECK (length(CAST(bytes AS BLOB)) BETWEEN 1 AND 65536 AND instr(bytes, char(0)) = 0);
