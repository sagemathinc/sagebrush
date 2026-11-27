-- When a session's person last re-authenticated: a WorkOS sign-in forced with max_age=0 (/auth/login?reauth=1),
-- whose signed sign-in state asked for it, in ms on D1's clock; or /auth/dev's (DEV only).  NULL for every other
-- session: an ordinary or legacy sign-in, and any session that proves no fresh sign-in.  A refresh never moves it and
-- no session inherits it.  The fleet's person routes read it to decide whether a signed write's sign-in is fresh.
-- Additive only: every existing row reads NULL (never re-authenticated).  Required before this server is deployed in
-- every auth mode: its session reads select sessions.reauth_ms.
ALTER TABLE sessions ADD COLUMN reauth_ms INTEGER CHECK (reauth_ms IS NULL OR (reauth_ms >= 0 AND reauth_ms <= 9007199254740991));
