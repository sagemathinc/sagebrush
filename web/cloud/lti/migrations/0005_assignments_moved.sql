-- amendment 3 r15 §2.3: assignments, their revisions and bundles live in
-- LtiContent (migrations/content/), not in the registry.  The stage-B table
-- held only synthetic rows (no production data exists), so it is dropped, not
-- migrated, with its quota rows; its triggers go with it.
DROP TABLE assignments;
DELETE FROM quota WHERE kind IN ('assignments', 'public_assignments');
