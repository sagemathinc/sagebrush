-- The mapping witness in D1 (amendment 1 r6 §2.4): the registration's epoch,
-- its high-water seq, and the restore hold.
ALTER TABLE registrations ADD COLUMN mapping_epoch TEXT;
ALTER TABLE registrations ADD COLUMN mapping_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE registrations ADD COLUMN mapping_hold INTEGER NOT NULL DEFAULT 0;
