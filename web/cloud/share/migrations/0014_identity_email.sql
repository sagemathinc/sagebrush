-- A WorkOS identity's verified email: the address WorkOS's own server-side answer (the code exchange's at sign-in, a
-- refresh's afterwards, both made with the API key) gives for the verified token's subject, only when WorkOS says it
-- is verified, trimmed and lowercased; NULL otherwise.  Written only by the WorkOS sign-in (in its session's batch)
-- and by a successful fenced refresh (in the refresh's own batch), so nothing else (a dev sign-in, a CoCalc-era row,
-- a client) can set it.  email_at: when it was last written (seconds).
--
-- email_obs orders the answers: before each /authenticate request, sign-in's or a refresh's, a ticket is taken from
-- identity_email_clock (one row, its n only ever incremented), and an answer is written only while its ticket is
-- greater than the identity's email_obs, in the same UPDATE.  So an older answer still in flight (another session's
-- refresh, or a sign-in racing a refresh) can never restore an address a newer answer replaced or cleared, nor move
-- email_at.  Additive only.
ALTER TABLE identities ADD COLUMN email TEXT;
ALTER TABLE identities ADD COLUMN email_at INTEGER;
ALTER TABLE identities ADD COLUMN email_obs INTEGER;
CREATE INDEX identities_email ON identities(email) WHERE email IS NOT NULL;
CREATE TABLE identity_email_clock (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
INSERT INTO identity_email_clock (id, n) VALUES (1, 0);
