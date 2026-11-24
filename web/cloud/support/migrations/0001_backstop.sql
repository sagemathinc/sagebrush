-- The support Worker's abuse backstop (plan-support-requests r12 §3.1 step 8): one row per UTC hour
-- ("h:YYYY-MM-DDTHH") and per UTC day ("d:YYYY-MM-DD"), counts only, no content.  `created` is unix seconds,
-- for the cron's cleanup (hour rows after 2 days, day rows after 30).  Applied by hand, DEV first.
CREATE TABLE IF NOT EXISTS support_backstop (
  win TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  created INTEGER NOT NULL
);
