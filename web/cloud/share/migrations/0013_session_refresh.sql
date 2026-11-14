-- WorkOS sessions kept valid by refreshing, and every provider session's revocation kept as an obligation until it is
-- delivered.  Additive only.
--
-- A session's refresh token is stored sealed (AES-GCM, a fresh nonce per write, bound to the environment, identity,
-- session and key version); refresh_ct is compared on every write, so a refresh that lost a race never writes back a
-- stale token.  refresh_failed: when the last refresh attempt failed for want of WorkOS (it never moves validated).
ALTER TABLE sessions ADD COLUMN refresh_ct TEXT;
ALTER TABLE sessions ADD COLUMN key_version TEXT;
ALTER TABLE sessions ADD COLUMN refresh_failed INTEGER;
CREATE INDEX sessions_sid ON sessions(provider_sid) WHERE provider_sid IS NOT NULL;
CREATE INDEX sessions_abs ON sessions(abs_expires) WHERE abs_expires IS NOT NULL;

-- A WorkOS session we must still ask WorkOS to end: from a sign-out, a sign-out everywhere, an account disabled or
-- deleted, a session evicted or past its absolute end, or a sign-in refused after WorkOS made a session.  sid_unknown:
-- an exchange whose answer was lost (WorkOS may have made a session we can't name); kept and counted, never drained.
-- exhausted: delivery failed MAX attempts; kept and counted until an admin resolves it.
CREATE TABLE revoke_outbox (
  id INTEGER PRIMARY KEY,
  sid TEXT,
  account_id TEXT,
  sid_unknown INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  created INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  exhausted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX revoke_outbox_due ON revoke_outbox(next_at) WHERE exhausted = 0 AND sid_unknown = 0;

-- A sign-in's slot, reserved before its code is sent to WorkOS, so no WorkOS session can exist without room for its
-- revocation: pending exchanges + sessions holding a provider sid + outbox rows never exceed the configured capacity.
CREATE TABLE pending_exchanges (
  id TEXT PRIMARY KEY,
  started INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX pending_exchanges_expires ON pending_exchanges(expires);
