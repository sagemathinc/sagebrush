-- A version's title, bounded (at most 200 characters, as written), for link
-- previews (share-ux-plan r2 §6.1): a public page reads it from D1, never
-- from the version's R2 manifest.  Existing versions: each collection's
-- latest gets the collection's title, which is that version's title (a new
-- version sets both); older versions stay NULL, and their previews are the
-- generic page.
ALTER TABLE versions ADD COLUMN title TEXT;
UPDATE versions SET title = (SELECT c.title FROM collections c WHERE c.id = versions.collection AND c.latest = versions.hash) WHERE title IS NULL AND hash IN (SELECT latest FROM collections WHERE latest IS NOT NULL);
