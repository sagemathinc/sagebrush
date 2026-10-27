-- Receipts of first uploads (plan-upload-leak r3 §3a): a share's collection is
-- created by its first version's own transaction, with one row here, so a
-- failed upload leaves no empty collection, and a retry of the same attempt
-- (its response lost, the page reloaded) gets the same share back, never
-- another one.  Only new objects: no existing table is touched.
CREATE TABLE upload_receipts (
  owner TEXT NOT NULL,
  attempt_hash TEXT NOT NULL,      -- sha256 of the page's random attempt (the attempt itself is never stored)
  request_digest TEXT NOT NULL,    -- sha256 of the request's normalized manifest fields: title, license, files
  collection TEXT NOT NULL,
  version TEXT NOT NULL,           -- the exact version that request created
  state TEXT NOT NULL,             -- committed, or retired (its collection was deleted)
  created INTEGER NOT NULL,
  retired INTEGER,
  PRIMARY KEY (owner, attempt_hash)
);
CREATE INDEX upload_receipts_collection ON upload_receipts(collection);
CREATE INDEX upload_receipts_retired ON upload_receipts(retired) WHERE state = 'retired';
