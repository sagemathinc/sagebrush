-- Remote relay usage, per account and UTC day (core design remote-v1 §5): what the account's RemoteAccount Durable
-- Object granted (byte leases) and what its relays consumed of them.  Reporting only, written by that object at most
-- once a minute; the object's own storage is the authority.  web/remote/account.ts.
CREATE TABLE remote_usage (
  account TEXT NOT NULL,
  day TEXT NOT NULL,
  granted INTEGER NOT NULL,
  consumed INTEGER NOT NULL,
  PRIMARY KEY (account, day)
);
