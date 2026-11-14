-- Sagebrush-owned identity: the account is ours; a sign-in provider (WorkOS) only names who signed in, by
-- (issuer, subject).  Additive only: nothing here changes how a deployment without AUTH_PROVIDER signs people in.
--
-- An identity is created together with its account in one batch with no ON CONFLICT, so a parallel sign-in that
-- loses the UNIQUE(issuer, subject) race rolls its whole batch back (no orphaned account) and reads the winner's.

CREATE TABLE identities (
  identity_id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  created INTEGER NOT NULL,
  last_used INTEGER,
  UNIQUE (issuer, subject)
);
CREATE INDEX identities_account ON identities(account_id);

-- sign-out-everywhere and disable fence (generation, signed_out_all_at); disabled: no sign-in, no session
ALTER TABLE accounts ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN disabled INTEGER;
ALTER TABLE accounts ADD COLUMN signed_out_all_at INTEGER;

-- kind: 'legacy' (a CoCalc sign-in, every row before this migration), 'workos' or 'dev' (/auth/dev); a deployment
-- accepts only its own mode's kinds.  The identity a session was made with, the provider's session id (for revoking
-- it), the absolute end (creation + 30 days, never moved), the last successful validation, and the fence values.
ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE sessions ADD COLUMN identity_id TEXT REFERENCES identities(identity_id);
ALTER TABLE sessions ADD COLUMN provider_sid TEXT;
ALTER TABLE sessions ADD COLUMN abs_expires INTEGER;
ALTER TABLE sessions ADD COLUMN validated INTEGER;
ALTER TABLE sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;

-- A sign-in attempt's state is used once: its nonce's hash is recorded here until the state expires.
CREATE TABLE auth_states (
  nonce_hash TEXT PRIMARY KEY,
  expires INTEGER NOT NULL
);
CREATE INDEX auth_states_expires ON auth_states(expires);
