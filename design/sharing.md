# Shared collections

*Status: the server side is built and tested (web/share/, web/files/) and runs on a dev deployment. The pages that use it come next.*

A **collection** is a directory of notebooks, boards and data files that someone uploads to sagebrush.space and shares with a link. Opening the link shows the files and lets anyone run them in the browser. Nothing runs until the reader asks.

## Storage

- **Every upload is its own R2 object:** `a/<hash of the account id>/<random name>`.
  - Nothing in R2 is shared between accounts, or between two uploads of one account.
  - So deleting an object can never remove bytes someone else, or a later upload, relies on.
- **A version is a manifest,** an object of its own:
  - fields: `{format: "sagebrush-collection", version: 1, collection, created, title, license, parent, files: [{path, sha256, size}]}`, as JSON with sorted keys;
  - the version's name is the SHA-256 of those bytes;
  - a frozen version's link (`/s/<id>@<hash prefix>`) never changes;
  - the collection's own link (`/s/<id>`) follows its latest version.
- **D1** holds accounts, sessions, collections and versions, which version uses which file, and *holdings*: which account uploaded which file (by SHA-256), in which object. The schema is in `web/share/migrations/`.
- **The database is the index.** R2 objects alone don't say who owns what, so D1's nightly export is an essential backup, not an optional one.

## Accounts

**Accounts are CoCalc accounts.**
- Sign-in is an OAuth 2 authorization code flow with PKCE (S256). CoCalc's own sign-in methods (passkeys, two-factor, magic links) come with it.
- A verified email is required, and there are no anonymous uploads.
- Sagebrush keeps its own session: a random token in a `__Host-` cookie (HttpOnly, Secure, SameSite=Lax), stored only as its SHA-256.
- **Everything is keyed by CoCalc's `account_id`, never by email,** since an email can change or be reused by a later account.

**Limits come from the CoCalc membership tier,** through a server-to-server call: `{storage_bytes, max_file_bytes, private_links}`.
- They are cached for 10 minutes.
- If CoCalc can't be reached, the cached value is kept. With nothing cached, uploads are refused: an outage is never read as a quota of zero, or as no limit.

## Uploading

1. The page hashes each file and asks which ones the server is missing (`POST /api/share/check`, advisory).
2. It uploads those (`PUT /api/share/blob/<sha256>`, with its length).
   - The bytes are first **reserved** by one conditional INSERT that counts the account's files, manifests and running uploads. Concurrent uploads can't all pass one check.
   - R2 refuses bytes that don't hash to the SHA-256, and the stored size must equal the declared one.
3. It commits the version (`POST /api/share/collections/<id>/versions`).
   - Every file must be one the account uploaded, at its stated size, and every path a plain relative path.
   - The manifest's bytes count against the quota too.
   - Limits: 1,000 collections per account, 1,000 versions per collection, 10,000 files per version.

**Each step that depends on an earlier check ends in one D1 transaction** whose guard re-checks it: the account isn't being deleted, the collection is still its own, every file is still held. An R2 write whose D1 write then fails is found from its expired reservation and deleted by the scheduled job.

**Deduplication is per account.**
- An account can only reference files it has uploaded itself. Two accounts that upload the same bytes each store their own copy.
- **Nobody can learn whether someone else has uploaded a file,** since "missing" means "missing for you".
- **Nobody can keep another person's file alive by knowing its hash.**

**Size limits.** A Worker can't take a request body over 100 MB, so single files are limited to 95 MB for now. Larger files will go up in parts.

## Serving: the user-content domain

Uploaded bytes are never served from sagebrush.space. A separate Worker (web/files/) serves them from `files.cocalcusercontent.com`.

**Reading goes through a collection:** `/c/<collection>/<sha256>`, and only for files of that collection's versions.
- A hash alone reads nothing: not another collection's files, and not an upload never shared.
- "Not shared" and "absent" are the same 404.

Each response:
- is an attachment of type `application/octet-stream`;
- has `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, so an uploaded `.html` or `.svg` can never become a page on any origin;
- can be cached by the browser only (`private`). A reader who already fetched a file keeps that copy; deletion stops new reads.

Pages read the files with CORS, plus `Cross-Origin-Resource-Policy: cross-origin`, since sagebrush.space is cross-origin isolated. Range requests are supported, so code that reads part of a large file downloads only that part.

## Deleting

Users can always delete their data.
- **A collection:** in one transaction, its versions, and the files no other collection of the owner's uses. The files stop being served at once.
- **"Delete my shared data":** everything of the account's.
- **Deleting the CoCalc account** offers to do the same:
  - CoCalc sends a signed request to `POST /api/admin/purge` (HMAC-SHA256 over the timestamp, method, path and body; at most 5 minutes old);
  - it is idempotent per `request_id`, and the same id for another account is refused;
  - CoCalc retries from a durable queue until it is accepted.

**An account's deletion runs as follows:**
1. Atomically, it marks the account *deleting* and drops its sessions. From then on it can't sign in, and no request of its can write. For an account deleted in CoCalc, a tombstone (a hash of its id) keeps it from ever signing in again.
2. Its rows are deleted.
3. Its whole R2 prefix is queued for deletion.
4. The purge is done when the prefix is empty and no upload of the account is still running. Only then does a self-deletion let the account share again.

**Deletion is real and recoverable:**
- An R2 object D1 stops referencing goes into an outbox **in the same transaction**, and leaves the outbox only once R2 has deleted it. The scheduled job retries.
- A purge is claimed with a lease, so one run does it, and a crashed one is taken over.
- When it is done, nothing names the account id: the purge record keeps a hash, and counts of collections and bytes.
- Uploads never committed are dropped after a day.

## Backups

- **What is copied:** R2 (files, manifests, and the nightly D1 export, which is the index) to two places outside Cloudflare.
- **Credentials:** read-only credentials, and no delete permission at the second copy.
- **Encryption:** client-side, since private links mean private content.
- **Retention:** 30 days, so deleted data leaves the backups within 30 days.

## Security

- Opening a shared link never runs its code by itself.
- Shared code is someone else's code. It is meant to run in the separate runner (an opaque-origin sandboxed frame on the user-content domain), which comes before sharing opens widely.
- State-changing API requests must come from sagebrush.space's own pages (an `Origin` check) as JSON.

## Testing

`node web/share/test-share.mjs` runs the API and the files Worker in Miniflare, with D1 and R2, and a fake CoCalc for sign-in and limits. It covers:
- sign-in, including return paths that would leave the site;
- concurrent uploads against the quota, and manifests counted;
- reading only through a collection;
- recovery from failed writes and deletes;
- uploads;
- isolation between accounts;
- limits;
- deletion;
- the signed purge;
- the daily job.
