-- The agent kinds a runner offers (its `sagebrush remote --serve-agents --agent NAME=...`), as it last reported them
-- when one of its legs was admitted by the relay, so the account's computer list can name them before a page connects.
-- A hint only: a page's hello to the runner decides.  web/remote/server.ts.  DEV first; PROD only with William's
-- per-file OK.
--
-- agents: a JSON array of at most 4 names, in the runner's order, or NULL (none reported, or a report that wasn't a
-- valid list).  agents_at: when that report was admitted (ms, the Worker's clock), or NULL.  Both are written together,
-- only for an admitted leg of a live runner; nothing else writes them.
ALTER TABLE remotes ADD COLUMN agents TEXT;
ALTER TABLE remotes ADD COLUMN agents_at INTEGER;
