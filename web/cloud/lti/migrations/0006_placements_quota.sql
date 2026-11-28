-- Placements quota, charged once per row (plan-lti-r5 §15.1).  0004's BEFORE INSERT trigger charged a whole row on
-- every upsertPlacement, and SQLite runs BEFORE INSERT for an upsert that resolves to DO UPDATE too: a refresh of an
-- existing placement was charged again (count and bytes), so the counter grew with every launch until a false
-- 'quota' refusal.  Now: admission BEFORE INSERT only when no row exists for that placement yet, the charge AFTER
-- INSERT, which runs only for a row actually inserted (an upsert's update runs the UPDATE triggers instead, which
-- account the size difference), then every registration's counter set again from its rows.
DROP TRIGGER placements_quota_insert;
CREATE TRIGGER placements_quota_admit BEFORE INSERT ON placements
WHEN NOT EXISTS (SELECT 1 FROM placements WHERE placement = NEW.placement)
BEGIN
  SELECT RAISE(ABORT, 'quota') WHERE NOT EXISTS (SELECT 1 FROM quota WHERE scope = NEW.rid AND kind = 'placements' AND count < cap_count AND bytes + NEW.size <= cap_bytes);
END;
CREATE TRIGGER placements_quota_insert AFTER INSERT ON placements
BEGIN
  UPDATE quota SET count = count + 1, bytes = bytes + NEW.size WHERE scope = NEW.rid AND kind = 'placements';
END;
UPDATE quota SET count = (SELECT count(*) FROM placements p WHERE p.rid = quota.scope), bytes = (SELECT coalesce(sum(size), 0) FROM placements p WHERE p.rid = quota.scope) WHERE kind = 'placements';
