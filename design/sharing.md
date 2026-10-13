# Shared collections

*Status: the server side is built and tested (web/share/, web/files/) and runs on a dev deployment. The pages that use it come next.*

A **collection** is a directory of notebooks, boards and data files that someone uploads to sagebrush.space and shares with a link. Opening the link shows the files and lets anyone run them in the browser. Nothing runs until the reader asks.

## Storage

- **Files are blobs in R2, named by their SHA-256** (`b/<sha256>`).
  - They are immutable and stored once.
  - A new version uploads only the files that changed.
- **A version is a manifest:**
  - JSON with sorted keys, stored at `m/<sha256 of its bytes>`;
  - fields: `{format: "sagebrush-collection", version: 1, collection, created, title, license, parent, files: [{path, sha256, size}]}`;
  - a frozen version's link (`/s/<id>@<hash prefix>`) never changes;
  - the collection's own link (`/s/<id>`) follows its latest version.
- **D1** holds accounts, sessions, collections, versions, which version uses which blob, and *holdings* (which account uploaded which blob). The schema is in `web/share/migrations/`.
- **Manifests are self-describing,** so the database can be rebuilt from R2 alone.

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

1. The page hashes each file and asks which ones the server is missing (`POST /api/share/check`). The quota is checked here.
2. It uploads those (`PUT /api/share/blob/<sha256>`). R2 itself refuses bytes that don't hash to the name.
3. It commits the version (`POST /api/share/collections/<id>/versions`). The server checks that the account has uploaded every file, at its stated size, and that every path is a plain relative path.

**Deduplication is per account.**
- An account can only reference blobs it has uploaded itself. Two accounts that upload the same bytes share one stored copy, and each holds it.
- **Nobody can learn whether someone else has uploaded a file,** since "missing" means "missing for you".
- **Nobody can keep another person's file alive by knowing its hash.**

**Size limits.** A Worker can't take a request body over 100 MB, so single files are limited to 95 MB for now. Larger files will go up in parts.

## Serving: the user-content domain

Uploaded bytes are never served from sagebrush.space. A separate Worker (web/files/) serves them from `files.cocalcusercontent.com`. Each response:
- is an attachment of type `application/octet-stream`;
- has `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`.

So an uploaded `.html` or `.svg` can never become a page on any origin.

Pages read the files with CORS (and `Cross-Origin-Resource-Policy: cross-origin`, as sagebrush.space is cross-origin isolated). Range requests are supported, so code that reads part of a large file downloads only that part. The names are hashes, so responses are cached for good.

## Deleting

Users can always delete their data:
- **A collection:** its versions and manifests, then every blob the account no longer uses, and every blob no account holds any more.
- **"Delete my shared data":** everything of the account's, and its sessions.
- **Deleting the CoCalc account** offers to do the same:
  - CoCalc sends a signed request to `POST /api/admin/purge` (HMAC-SHA256 over the timestamp, method, path and body; at most 5 minutes old);
  - it is idempotent per `request_id`;
  - CoCalc retries from a durable queue until it is accepted.

**Deletion is real:**
- R2 objects and D1 rows are removed. A purge record keeps only who, when, how many collections and bytes.
- Worker responses are not cached at the edge, so a deleted file stops being served at once.
- Uploads never committed are dropped after a day by a daily job.

## Backups

- **What is copied:** R2 (blobs, manifests, and a nightly D1 export) to two places outside Cloudflare.
- **Credentials:** read-only credentials, and no delete permission at the second copy.
- **Encryption:** client-side, since private links mean private content.
- **Retention:** 30 days, so deleted data leaves the backups within 30 days.

## Security

- Opening a shared link never runs its code by itself.
- Shared code is someone else's code. It is meant to run in the separate runner (an opaque-origin sandboxed frame on the user-content domain), which comes before sharing opens widely.
- State-changing API requests must come from sagebrush.space's own pages (an `Origin` check) as JSON.

## Testing

`node web/share/test-share.mjs` runs the API and the files Worker in Miniflare, with D1 and R2, and a fake CoCalc for sign-in and limits. It covers:
- sign-in;
- uploads;
- isolation between accounts;
- limits;
- deletion;
- the signed purge;
- the daily job.
