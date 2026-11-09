-- Active users, first party (active-users plan r2 §2, r4a §2; the country addendum r1 §1, r2 §1).  Aggregate daily
-- counts only: no identifier, no IP, no per-account row.  DEV first; PROD only with William's per-file OK.
--
-- activity_days: per UTC day, the signed-in accounts ('account', client 'all') and the signed-out notebook-app
-- browsers ('browser', client 'web') counted that day (first_day), of them those counted for the first time that ISO
-- week (first_week) and month (first_month), and the accounts created that day (new_accounts).  Kept indefinitely.
-- Later counters are added as their own migrations, each INTEGER NOT NULL DEFAULT 0 (r4b §2).
CREATE TABLE activity_days (
  day TEXT NOT NULL, population TEXT NOT NULL, client TEXT NOT NULL,
  first_day INTEGER NOT NULL DEFAULT 0, first_week INTEGER NOT NULL DEFAULT 0,
  first_month INTEGER NOT NULL DEFAULT 0, new_accounts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, population, client)
) WITHOUT ROWID;

-- activity_country_days: the same three counts by the request's country (Cloudflare's request.cf.country, two
-- upper-case letters, else 'other'), written in the same batches.  Never with an id or an IP.
CREATE TABLE activity_country_days (
  day TEXT NOT NULL, population TEXT NOT NULL, country TEXT NOT NULL,
  first_day INTEGER NOT NULL DEFAULT 0, first_week INTEGER NOT NULL DEFAULT 0, first_month INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, population, country)
) WITHOUT ROWID;
