-- The accounts an admin view showed personal data of (the admin page's account browser): one row per account whose
-- verified email the view's page held, by the account's hash (sha256("sagebrush-account\n" + id), as
-- admin_views.target_hash), never its id, email or anything an admin typed.  Written in one batch after the view's
-- read and before its page is sent; if it can't be written, the page isn't sent.  Removed with its view, after the
-- admin log's retention.  Additive only: nothing reads or writes it until the admin page that does is deployed.
CREATE TABLE admin_view_targets (
  view_id INTEGER NOT NULL REFERENCES admin_views(id),
  target_hash TEXT NOT NULL
);
CREATE INDEX admin_view_targets_view ON admin_view_targets(view_id);
CREATE INDEX admin_view_targets_target ON admin_view_targets(target_hash);
