-- The erase journal (amendment 1 r6 §4.1): sealed recovery rows, kept 35
-- days, its own quota kind (700,000 per environment), never a handle in an
-- ordinary audit row.
INSERT INTO quota (scope, kind, cap_count, cap_bytes) VALUES ('env', 'erase_journal', 700000, 112000000);

CREATE TABLE erase_journal (
  erase_id TEXT PRIMARY KEY CHECK (length(erase_id) BETWEEN 16 AND 64),
  rid TEXT NOT NULL CHECK (length(rid) = 32),
  sealed TEXT NOT NULL CHECK (length(sealed) <= 400),
  completed INTEGER NOT NULL
);
CREATE INDEX erase_journal_completed ON erase_journal (completed);
-- Admission before, charging after (CORR-LTIMAP-4): a BEFORE trigger runs even when ON CONFLICT DO NOTHING
-- then skips the row, so it only admits, and a duplicate of an existing row is always admitted, even at the cap,
-- so a retried journal write stays acknowledgeable.  The charge is in the AFTER trigger, which runs only for a
-- row actually inserted.
CREATE TRIGGER erase_journal_quota_insert BEFORE INSERT ON erase_journal
BEGIN
  SELECT RAISE(ABORT, 'quota') WHERE NOT EXISTS (SELECT 1 FROM erase_journal WHERE erase_id = NEW.erase_id)
    AND NOT EXISTS (SELECT 1 FROM quota WHERE scope = 'env' AND kind = 'erase_journal' AND count < cap_count);
END;
CREATE TRIGGER erase_journal_quota_charge AFTER INSERT ON erase_journal
BEGIN
  UPDATE quota SET count = count + 1, bytes = bytes + 160 WHERE scope = 'env' AND kind = 'erase_journal';
END;
CREATE TRIGGER erase_journal_quota_delete AFTER DELETE ON erase_journal
BEGIN
  UPDATE quota SET count = count - 1, bytes = bytes - 160 WHERE scope = 'env' AND kind = 'erase_journal';
END;
