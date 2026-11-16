-- A WorkOS identity's verified email: the address WorkOS's own server-side answer (the code exchange's at sign-in, a
-- refresh's afterwards, both made with the API key) gives for the verified token's subject, only when WorkOS says it
-- is verified, trimmed and lowercased; NULL otherwise.  Written only by the WorkOS sign-in (in its session's batch)
-- and by each refresh (in the refresh's own batch), so nothing else (a dev sign-in, a CoCalc-era row, a client) can
-- set it.  email_at: when it was last written (seconds).  Additive only.
ALTER TABLE identities ADD COLUMN email TEXT;
ALTER TABLE identities ADD COLUMN email_at INTEGER;
CREATE INDEX identities_email ON identities(email) WHERE email IS NOT NULL;
