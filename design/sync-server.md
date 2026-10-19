# The sync server: backup and sync on Cloudflare

*Status: design, for review by astra (correctness), daybreak2 (limits) and William. Nothing here is built yet. When it is built, it stays behind a flag that is off in production (§11). No private user data is stored in production until William says so.*

This is the server side of design/workspace-files.md §7 (backup and sync) and §9 steps 8 and 9. The agent endpoint built on it is in design/agent-endpoint.md. The client is @sagebrush-board's, written against the protocol in §5, which we agree on together.

**What it reuses from sharing** (design/sharing.md, web/share/server.ts):
- the sign-in and session: CoCalc OAuth with PKCE, and a `__Host-` cookie stored only as its SHA-256;
- the account hash, `sha256("sagebrush-account\n" + account_id)`, which names things without naming the account;
- the R2 bucket, and the rules for writing to it: one object per upload, deletes through an outbox, and the purge;
- the limits from CoCalc, and the HMAC scheme of the signed purge request.

**What is new:**
- one Durable Object per account and one per document;
- the patch and batch protocol;
- snapshots;
- signed plan notices.

---

## 1. The parts

| Part | Name | Holds |
|---|---|---|
| **Worker** (the site's, web/site) | — | The HTTP routes and the socket upgrades. It authenticates the session, then calls exactly one object, naming the account it authenticated. It keeps no state. |
| **Account object** (`SyncAccount`, SQLite) | `idFromName("acct:" + account_hash)` | The workspace index and its operation log, the devices and their cursors, the blob holdings, the documents the account owns, data files' versions, limits, usage, grants and the access log (design/agent-endpoint.md), and the R2 outbox |
| **Document object** (`SyncDoc`, SQLite) | `idFromName("doc:" + owner_hash + ":" + doc_id)` | One notebook's, board's or chat's patch log (as batches), its snapshots, its outputs map, its access list, and its R2 outbox |
| **R2** (`sagebrush-share`, the same bucket) | `s/<account hash, 32 hex>/<random>` | Blob bytes, snapshots, archived patch segments, outputs, and daily exports |
| **D1** (`sagebrush-share`, the same database) | — | Only what sharing already has: accounts, sessions, tombstones, purges. The sync service adds one table, `sync_accounts` (§9), written when sync is turned on and when it is purged, never on an edit. |

**Why the document object's name includes the owner.** The document id is made by the client: it is random, 128 bits, and made offline. If the name were the id alone, anyone who learned an id could claim it before the owner first synced it. With the owner in the name, two accounts can't name the same object, so the id can't be squatted. A shared document (§7.9, phase 3) is reached by naming its owner and its id. The object checks its access list.

**Why `s/` and not sharing's `a/`.** "Delete my shared data" sweeps `a/<hash>/`, and "Delete my synced data" sweeps `s/<hash>/`, so neither removes the other's bytes. Deleting the CoCalc account sweeps both (§9). Both prefixes use the same hash, the same bucket and the same upload checks (R2 refuses bytes that don't match their SHA-256).

**Blobs are content-addressed per account,** as sharing's are:
- a holding maps the blob's SHA-256 to its R2 object, and is counted in the account's usage once;
- the object's key is random, so a blob uploaded again after a delete gets a new object, which a pending delete of the old one can't touch;
- **deduplication with sharing comes later:** a file both shared and synced is stored twice, once under `a/` and once under `s/`, until sharing's holdings move into the account object (workspace-files.md §7.3, "What follows for sharing"). The two holdings tables have the same columns, so that move only changes where the rows live;
- blob names are made by one function on the client, `blobAddress(bytes)`, which is SHA-256 today. End-to-end encryption (§10) would key it with the account's secret instead, and the server never computes it.

## 2. Who may call what

**Every request is authenticated by the Worker, which calls exactly one object, naming the account it authenticated.**
- Objects are not reachable from the internet. Only the Worker holds their bindings.
- An object trusts the `account_id` the Worker passes, and checks it against its own owner, or its access list. A document object refuses an account not on its list with 404, which is the same answer as for a document that doesn't exist.
- The account object calls its own documents' objects directly, for example to forward a batch, naming itself as the caller.

**Sessions:**
- A session is sharing's: the cookie, its hash, its row in D1.
- **A socket is authenticated once, at the upgrade,** by the Worker, with one D1 read. The upgrade must carry `Origin: https://<this site>`, which closes cross-site WebSocket hijacking. The socket then carries the session's hash and expiry as its attachment, so a message needs no D1 read.
- **The session is checked again from the object,** with one D1 read, when the socket next sends after 10 minutes since its last check. The session's expiry is checked on every message, from the attachment.
- **Ending a session closes its sockets at once:**
  - sign-out, "forget this device" and the purge all call the account object's `revoke(session_hash)` (for the purge: `revoke_all`), after the D1 change;
  - the account object closes its own sockets with that tag, and then the document sockets it gave tickets to (below);
  - if that call fails, the next check (within 10 minutes of activity) finds the session gone. A socket that sends nothing can do nothing, so a closed one is safe;
  - the purge retries `revoke_all` until it succeeds (§9).
- **A document socket needs a ticket from the account object,** asked for over the account socket:
  - the ticket is an HMAC (key `SYNC_TICKET_KEY`) over the account, the session hash, the owner, the document and an expiry 2 minutes away;
  - the account object records which documents it gave tickets to for each session, so `revoke` reaches them;
  - the document object rechecks the access list at the upgrade, and every 10 minutes after that while the socket is in use.

**State-changing HTTP requests** follow sharing's rules: they must carry `Origin` equal to the site, and be JSON or a blob PUT.

**Rate limits** are kept per account in the account object, and per document in the document object (§8). They are in memory, which a Durable Object makes exact, since one object runs one request at a time. They reset if the object is evicted, which happens only after it has been idle. The size limits (§8) don't depend on them.

## 3. The account object

SQLite tables (columns abridged):

```
meta(k, v)               account_id, account_hash, state: active | readonly | deleting,
                          limits (JSON), limits_issued, limits_fetched, used_bytes, ...
devices(device, name, created, last_seen, index_cursor, session_hash)
ops(seq INTEGER PRIMARY KEY, device, dseq, t, by, op, path, "to", kind,
    doc, sha256, size, fid, recv)                  UNIQUE(device, dseq)
entries(path PRIMARY KEY, kind, ref, mode, size, sha256, fid, created, updated,
        trashed_from, trashed_at, by, seq)          (the index as of the last op)
docs(doc PRIMARY KEY, kind, created, bytes, head_seq, epoch, deleted)
holdings(sha256 PRIMARY KEY, key, size, refs, created)
versions(fid, n, sha256, size, t, by, device)      PRIMARY KEY(fid, n)   (§2.5)
reservations(id PRIMARY KEY, bytes, key, expires)
outbox(key PRIMARY KEY, created)                    (R2 objects to delete)
tickets(session_hash, doc, expires)
grants(...), access_log(...)                         (design/agent-endpoint.md)
```

**The operation log is the index's history** (§7.2).
- The client's log (`Op` in web/workspace/api.ts on the `workspace-index` branch: `{seq, t, device, by, op, path, to, kind}`) is uploaded as it is, plus the reference each op needs:
  - for a document, its `doc` id;
  - for a data file, its `sha256`, `size` and `fid`.
- **Idempotent by `(device, dseq)`,** where `dseq` is the device's own `seq`. An op sent again is acknowledged and not applied twice.
- The server gives each op it accepts a `seq` of its own. **The server's order is the order of the log:** every device applies the ops in `seq` order, so all of them reach the same index.
- **One reducer.** The conflict rules of §7.2 (the later rename wins; an edit after a delete brings the file back out of Trash; a second new file at a path becomes `name (2)`) are one pure function, `reduce(entries, op) -> entries'`. It lives in `web/workspace/sync-reduce.ts` and is used by the client and by the server, with one test suite, so they can't disagree.
- `t` is the device's clock, shown to the person, and never used for order.
- The server keeps `entries`, the result, because it needs paths: for quota, for an agent's scope (design/agent-endpoint.md), and to answer `list` while every device is closed. §10 says what this means for end-to-end encryption.
- **Checked when applied:** the path (`normPath`'s rules, with the same tests as the client), the kind, the size, and that a referenced blob is held (`refs` + 1 in the same transaction) or a document is the account's. An op that fails a check is refused with its code, and the rest of the batch still applies (§5.2).

**Data files' versions (§2.5) are kept on the server too,** since a backup without them would lose what versions keep.
- A write that replaces a data file's `sha256` adds the old one as version `n`, in the same transaction.
- The client's retention rules apply, enforced by the reducer: the latest 20, none older than 30 days, and all together at most the account's version budget.
- Dropping old versions is an op only a person may send (`by: "person"` from a session, never from a grant: design/agent-endpoint.md).

**A blob's references:** an entry, a version, a snapshot, an outputs value. When a holding reaches `refs = 0`, it goes into the outbox in the same transaction. A holding with no reference at all, a day after its upload, is unused and goes into the outbox too. The account object's alarm empties the outbox: it deletes the R2 object, and only then the row.

**Usage** (`used_bytes`) is kept up to date in the same transaction as each change: holdings, plus the document objects' bytes (each batch reports its size back), plus running reservations. It is never a `SUM` over a table. A daily recount from the tables corrects drift, and logs any it finds.

## 4. The document object

```
meta(k, v)        owner_hash, owner_account, doc, kind, created, epoch, head_seq, bytes
acl(account, role)                         owner; editors and viewers in phase 3
batches(seq INTEGER PRIMARY KEY, epoch, device, author, recv, n, first_id, last_id,
        ids TEXT, body BLOB)               one row per batch
clients(client_id PRIMARY KEY, hwm)        idempotency: the newest patch id accepted from each patchflow client
segments(first_seq, last_seq, key, bytes)  older batches, moved to R2
snapshots(at_seq, key, sha256, bytes, by, t)
outputs(cell, sha256, size, by, t)         (§7.2: the latest outputs, by hash)
outbox(key PRIMARY KEY, created)
```

**One row per batch,** as §7.8 requires. A patch is never a row of its own, since a row per patch would cost about 30 times more (§7.3).

**The payloads are opaque.** A batch's `body` is the bytes the client sent: its patchflow envelopes, which the server never parses (§10). The server reads only the envelope fields the protocol puts beside them (§5.3):
- each patch's id (patchflow's `time`, which encodes a time and its client's id);
- its parents' ids;
- its size;
- its author.

**Idempotent by patch id,** without a row per patch:
- **The client's rule.** A patchflow client's patch ids only increase:
  - an id is `<time, base 36, fixed width>_<clientId>`;
  - its time is `max(clock, last seen + 1)`, from `Session.nextTimeMs` in patchflow 0.12, session.js:591;
  - so for one `clientId`, a later patch has a larger id.

  A client sends its patches oldest first, and one batch is accepted whole or not at all.
- **The server's rule.** It keeps each client's newest accepted id (`clients.hwm`). Patches at or below it are already accepted, so it drops them and acknowledges them. Patches above it are new.
- **The server checks the client's rule**, so a client that breaks it is refused rather than losing patches:
  - within a batch, each client's ids must strictly increase;
  - every parent must be already accepted (at or below its own client's `hwm`), or earlier in the same batch.
  - A batch that fails either check is refused whole, with `order`, and the client resends from its oldest unacknowledged patch.
- `batches.ids` keeps the batch's ids, compressed, for the rare exact lookup: TimeTravel's "which device made this", and a client resynchronizing after a lost acknowledgement.
- **The `clients` table:**
  - patchflow makes a new `clientId` for each session, so a document gets one row per session that sent it a batch. There are never more rows than batches;
  - the rows are about 60 bytes each, and are kept for the document's life;
  - they are never pruned, since a pruned row would let a late resend be stored twice. The epoch empties them.

**The epoch: "clear history" (§7.2):**
- clearing a document's history is a request from a person's session (never a grant);
- in one transaction, it raises `epoch`, moves every batch, segment and snapshot to the outbox, and empties `clients` (a client's old patches are no longer accepted, so its newest id is no longer a bound);
- from then on, a batch with an older epoch is refused with `epoch`. The client must drop its local history before it sends again, so another device can't send the history back.

**Snapshots** bound the replay for a new device (§7.2).
- **A snapshot is made by a client,** because only a client can read the payloads:
  - the client holds the document at batch `at_seq`;
  - it uploads the snapshot as a blob, and registers `{at_seq, sha256, bytes}`;
  - the server checks only that `at_seq` is a batch of the current epoch, and that the blob is held.
- **Who may make them:** only the owner's sessions, because a snapshot is trusted by every device that opens from it. In phase 3, a collaborator's snapshot would be a way to show the owner a document that differs from its history.
- **A snapshot never replaces history.** The batches stay (TimeTravel shows every version), and a device can always rebuild from the batches alone. "Rebuild from history" in the Sync panel does exactly that, and checks the result against the snapshot.
- **When:** the client offers one after 500 batches or 4 MB of patches since the last snapshot. The server keeps the latest 3.

**Compaction moves old batches to R2,** so a document object stays small however long its history:
- every batch older than the latest snapshot, beyond the latest 200, is concatenated as bytes, never parsed, into a segment object in R2 (`s/<hash>/<random>`);
- in one transaction, the segment row is written and those batch rows are deleted;
- the document object's alarm does this when it is awake anyway, at most once an hour;
- the order of steps is: the segment goes to R2, then the transaction. A crash between the two leaves an R2 object nothing references. The daily inventory (§9) finds it.

**Outputs** (§7.2): a map from cell id to the blob of its latest outputs. The latest write wins, in the server's order. Each value refers to a held blob, counted like any reference.

**Exports for backups off Cloudflare** (sharing.md "Backups"):
- once a day, if anything changed, the document object writes its batches since the last export as one more segment;
- the account object writes its `entries`, `ops` and `versions` as one export object;
- so everything an account has is in R2 within a day, where sharing's off-site copies already go;
- the Durable Objects' own point-in-time recovery (30 days) covers the hours in between.

## 5. The protocol

Version 1. JSON messages over WebSockets, plus HTTP for blobs and for the case where a socket can't be used. The client is @sagebrush-board's. Every field is listed here, and nothing else is accepted: an unknown field is a 400, because a field the server ignores today could change meaning tomorrow.

### 5.1 Connections

- **The account socket.** One per device, always open while the page is, at `GET /api/sync/v1/account` (upgrade).
  - It carries the index, the batches for documents nobody else has open, and the notifications that a document changed elsewhere.
  - It uses the hibernation API (§7.3).
- **A document socket,** at `GET /api/sync/v1/doc/<owner>/<doc>?ticket=…` (upgrade).
  - It is opened only while another device or person also has the document open. The account object says when: it sends `watching`.
  - Batches then go to it at once, not every 30 seconds, and presence rides on it without being stored (§7.9).
- **HTTP, for when a socket isn't open:** `POST /api/sync/v1/batch`, with the same body as a socket's `batch`.
  - This is for a page being hidden or closed (`fetch(…, {keepalive: true})`), and for an agent (design/agent-endpoint.md).
  - A keepalive request's body is at most 64 KiB, so the page sends what fits, and the rest goes when it opens again.

### 5.2 The account socket's messages

Client to server:

```
{t: "hello", v: 1, device, name, index_after: seq, docs: [{owner, doc, after: seq}]}
{t: "ops", req, ops: [{dseq, t, by, op, path, to?, kind, doc?, sha256?, size?, fid?}]}
{t: "batch", req, owner, doc, epoch, kind?, patches: [Env], body: base64}
{t: "pull", req, owner, doc, after: seq, limit?}
{t: "ticket", req, owner, doc}
{t: "snapshot", req, owner, doc, at_seq, sha256, bytes}
{t: "outputs", req, owner, doc, set: [{cell, sha256, size}]}
```

Server to client:

```
{t: "welcome", v: 1, state, limits, used_bytes, index_head, server_time}
{t: "ack", req, ok: [dseq | patch id], refused: [{id, code, detail?}], seq?}
{t: "index", ops: [... with seq]}                    the log since index_after, then as it grows
{t: "changed", owner, doc, head_seq, by_device}      another device sent a batch
{t: "watching", owner, doc, n}                       others have this document open: use a document socket
{t: "batches", req, owner, doc, epoch, from_seq, items: [{seq, author, device, body}],
               snapshot?: {at_seq, sha256}, more: bool}
{t: "ticket", req, ticket, expires}
{t: "error", req?, code, detail}
{t: "revoked"}                                        followed by close 4401
```

- **`Env`**, the envelope beside the opaque body: `{id, parents: [id], size}` for each patch, in the body's order. The author isn't in it: the server sets the author from the session or grant that sent the batch, and never takes it from the client (§7.10, §8.7).
- **`pull`** answers with batches after `after`. If `after` is older than the latest snapshot's `at_seq`, and older than the batches still in the object, it answers with the snapshot and the batches since it. Segments are read from R2 only for TimeTravel's "load more history".
- **Every `req`** is the client's number, echoed in its answer. A client may have at most 8 requests unanswered on a socket. Beyond that, the server answers `busy`.
- **Codes** that `refused` and `error` use:
  - `invalid`: the shape;
  - `exists`, `missing`, `conflict`: the index rules;
  - `order`, `epoch`, `unknown_doc`;
  - `limit`: a size, with `detail` saying which;
  - `storage_full`;
  - `rate`: with `retry_after`;
  - `readonly`, `deleting`, `busy`.

### 5.3 Batches

- **A batch is the patches of one document,** at most 1 MiB of body and 2,000 patches. A batch fits in one SQLite row, which can be at most 2 MB (§7.8).
- **A patch over 256 KiB** (pasting a large cell, say) goes up as a blob first. The patch in the batch then refers to the blob, through a field patchflow keeps (`meta.blob: sha256`), and the client resolves it when it reads the patch.
- **When batches are sent:**
  - when nobody else has the document open, every ~30 seconds, and at once when the page is hidden;
  - over a document socket, as patches are made, at most 4 a second.
- **What happens to a batch:**
  - The account object forwards it to the document object. The document object checks it (§4), stores it as one row, and answers with its `seq`.
  - The account object then updates `docs.head_seq` and `bytes`, and sends `changed` to the account's other devices.
  - This is one call from the account object to the document object, and one row in each.

### 5.4 Blobs

```
POST /api/sync/v1/blobs/check   {blobs: [{sha256, size}]}  -> {missing: [sha256]}
PUT  /api/sync/v1/blob/<sha256> the bytes (Content-Length required)
GET  /api/sync/v1/blob/<sha256> -> 303 to a signed URL on the user-content domain
```

**Uploading follows sharing's steps:**
1. The account object reserves the bytes with one conditional write against the limit (`max_file_bytes`, and `storage_bytes` minus usage).
2. The Worker streams the body to R2, with the SHA-256 for R2 to check. The stored size must equal the declared one.
3. The account object turns the reservation into a holding with `refs = 0`. The holding counts only once something refers to it, or is dropped after a day (§3).

**Reading:**
- Uploaded bytes are never served from sagebrush.space (sharing.md, "Serving").
- The account object checks that the blob is the account's. The Worker then redirects to `https://files.cocalcusercontent.com/p/<key>?exp=…&sig=…`, a URL signed (HMAC, key `SYNC_URL_KEY`) for that object and good for 5 minutes.
- The files Worker checks the signature and serves the object the way it serves shared files: an attachment, `nosniff`, `default-src 'none'; sandbox`, `private`, CORS for sagebrush.space, and ranges.
- A signed URL that leaks reads one blob for 5 minutes, and reads nothing else.
- Single files are at most 95 MB until multipart uploads exist (as sharing's, §7.8).

## 6. Limits from cocalc.ai, and the plan notice

**The limits** are sharing's call, `GET /api/v2/sagebrush/limits?account_id=…`, with one more field for sync: `{storage_bytes, max_file_bytes, private_links, sync: {enabled, storage_bytes, version_bytes}}`. CoCalc decides the numbers per membership; they are not in this repository (sagebrush/business-material-out-of-repo).
- **They are cached in the account object for 6 hours,** not 10 minutes (§7.3). With 100,000 accounts active, that is about 5 requests a second to cocalc.ai.
- **When the cache is old,** the limits are fetched again, and the cached value is used while the fetch runs.
- **If CoCalc can't be reached,** the cached value is kept, however old. With nothing cached, uploads are refused and document batches are still accepted (below). An outage is never read as zero, or as no limit.

**The plan notice:** `POST /api/admin/limits`, from cocalc.ai, when an account's plan changes.
- The body is `{request_id, account_id, issued, limits}`.
- It is signed the way the purge request is: HMAC-SHA256 over the timestamp, method, path and body, at most 5 minutes old. The key is a separate one, `LIMITS_KEY`, so a leaked limits key can't purge, and the reverse.
- **It is applied only if `issued` is newer** than the cached value's. So a notice that is replayed, or arrives late, can never undo a newer one. A fetch also records the issue time CoCalc returns.
- **For an account that never turned on sync,** the notice is a no-op: 200 with `{applied: false}`. Nothing is created for it.

**What the limits do:**
- **Over `storage_bytes`:**
  - blob uploads stop with `storage_full`, and the page says so;
  - **document batches keep being accepted,** since edits are small (§7.4), up to a hard ceiling of the limit plus 10% (at least 50 MB). Beyond the ceiling they are refused with `storage_full`, and wait on the device;
  - nothing already synced is removed.
- **`sync.enabled` false** (the plan no longer includes sync): the account becomes `readonly`.
  - Nothing is deleted.
  - Every write is refused with `readonly`.
  - Reading, pulling and "Download all" keep working.
  - The page says why (§7.4).

## 7. Deleting

| What | Who | What happens |
|---|---|---|
| **A file or document** in the workspace | the person or an agent: an op | To Trash. Only emptying Trash (a person's op) removes contents: an entry's blob loses a reference, a document object is told to delete itself (below). |
| **Old versions of a data file** | only the person | Their blobs lose a reference. |
| **A document's history** ("Clear history") | only the person | The epoch (§4). |
| **"Delete my synced data"** | the person, from the Sync panel, with a confirmation | The account object goes through the steps below. Sharing's data and the session stay. |
| **Deleting the CoCalc account** | CoCalc's signed purge (sharing.md) | Sharing's purge, and in the same purge record, the account object's purge. Then the tombstone, as now. |

**A document object deletes itself as follows:**
1. In one transaction, it marks itself deleted, moves every batch, segment, snapshot and output to its outbox, and clears its access list.
2. It closes its sockets.
3. Its alarm empties the outbox.
4. It then calls `deleteAll()`.

The account object keeps the `docs` row, marked deleted, until the document object confirms it is empty.

**The account object purges as follows,** idempotently and from its own alarm:
1. In one transaction, `state = deleting`, which refuses every request from then on except reads by the purge, and `revoke_all`, which closes every socket.
2. Each owned document deletes itself, as above. The alarm retries until every one has confirmed.
3. Every holding and export goes to the outbox, which is emptied. Then the whole `s/<hash>/` prefix is listed and deleted, which catches anything the tables missed.
4. `deleteAll()`. The D1 row `sync_accounts` is marked `purged`, with counts and no id (as sharing's purge records are).

**What happens to sync while it is being deleted:**
- A device that is online is told `deleting`, and stops.
- Its local copy is left in place, as turning sync off leaves it (§7.4).
- Turning sync on again is refused until the purge is done.

## 8. Limits, sizes and rates

For daybreak2's review. Each is enforced by the server, and each has a test. The numbers are first values: they are counted in tests, and changed where a test shows they are wrong.

| What | Limit | Over it |
|---|---|---|
| A message on a socket | 1 MiB + 64 KiB | close 1009 |
| A batch | 1 MiB of body, 2,000 patches; 8 parents per patch | `limit` |
| One patch inline | 256 KiB (larger: a blob, §5.3) | `limit` |
| Ops in one message | 500; a path 1,024 bytes, a name 255 | `limit` |
| The index | 100,000 entries, 10,000 per folder (as the client's `LIMITS`) | `limit` |
| Documents per account | 100,000 | `limit` |
| Requests unanswered per socket | 8 | `busy` |
| Account sockets | 20 per account (the oldest is closed) | close 4408 |
| Document sockets | 50 per document | `busy` |
| Batches per account | 20 a second, sustained 4 a second | `rate`, with `retry_after` |
| Ops per account | 2,000 a minute | `rate` |
| Blob uploads | 4 at once per account; `max_file_bytes` each | 429, 413 |
| Signed URLs | 600 a minute per account | 429 |
| Snapshots kept | 3 per document | the oldest goes |
| Live batches before compaction | 200 beyond the latest snapshot | compacted |

- **Every limit is checked before any write.** A refusal changes nothing.
- **A client over a rate** waits for `retry_after`. Its changes stay on the device, and nothing is lost.

## 9. D1, the scheduled job, and the purge

- **`sync_accounts(account_hash PRIMARY KEY, state, created, purged, counts)`:**
  - it is written when sync is turned on, and it is how the purge finds that an account has an account object;
  - the hash alone names the object, so the row needs no account id.
- **The purge** (sharing's `purgeAccount`): if the account has a `sync_accounts` row, the purge record also waits for the account object's purge. The purge's `files` step then covers both prefixes.
- **The daily job** (sharing's `scheduled`):
  - it also lists `s/` a page at a time, as its inventory does for `a/`;
  - it asks the owning account object about each object older than two days, and deletes those the account object doesn't know (holdings, segments, snapshots, exports, reservations);
  - this catches an R2 write whose transaction failed.

## 10. Encryption

**(a), as decided (§7.4):** R2 and Durable Object storage are encrypted at rest by Cloudflare.

**What keeps (b), end-to-end, possible later:**
- **Opaque now:**
  - patches (batch bodies), snapshots, outputs and blob bytes are bytes to the server;
  - it never parses them, and nothing in this design needs it to;
  - blob names come from one client function (§1).
- **Not opaque now: the index.**
  - Paths, kinds and sizes are visible to the server, because the server needs them for quota, for an agent's scope, and to answer an agent while every device is closed.
  - Under (b), the index would be encrypted too. The cost:
    - quota would count bytes only;
    - an agent's scope would be checked only in the page;
    - the agent endpoint (design/agent-endpoint.md) would work only with a key the person gives that agent, or through an open page.
  - That is the real trade-off of (b), and it isn't hidden by this design.
- **The agent endpoint's document verbs do parse documents** (design/agent-endpoint.md §4). They do so in their own module, never in the objects above. Under (b), they would need that key.

## 11. The flag, and what is deployed

- **The bindings are the flag.** The Durable Object classes and `SYNC_*` bindings appear only in the dev site's configuration (`dev.sagebrush.space`, its own D1 database and R2 bucket, as sharing's do now).
  - The production configuration has no sync bindings, so `/api/sync/` answers 404 "sync is not enabled here", as sharing's routes do without theirs.
  - The classes are compiled into the site's Worker either way. Without a binding, nothing can reach them.
- **Turning it on in production** is a change to `web/site/cloudflare.config.ts`, and only William makes it (§7.4: no production storage of private user data until he says so).
- **Nothing public-facing changes:** no new domain, no DNS record. Signed blob URLs use a new path, `/p/`, on the existing user-content Worker, which is dev-only too until William says otherwise.

## 12. Tests

The tests run in Miniflare, as `web/share/test-share.mjs` does, with Durable Objects, D1, R2 and a fake CoCalc.

**Tests of the server:**
- **Isolation:**
  - one account can't read, write or learn of another's documents, blobs or index;
  - a document object refuses an account not on its list;
  - a forged owner in a URL reaches nothing.
- **Idempotence:**
  - an ops message and a batch, each sent twice, and again after a lost acknowledgement, apply once;
  - a batch whose client order is broken, or whose parents are unknown, is refused whole;
  - two devices sending to one document at once, through the account socket and a document socket, are ordered once.
- **Sessions:**
  - sign-out, forget-device and the purge close the sockets they should;
  - an expired session's socket can't write;
  - a revoke whose call failed is caught by the 10-minute check;
  - a ticket can't be used for another document, account or session, or after it expires.
- **Limits:** every row of §8, at the limit and one over it, and a refusal changes nothing.
- **Quota:**
  - concurrent uploads can't all pass one check;
  - edits are accepted over the limit up to the ceiling, and not beyond it;
  - an outage keeps the cached limits.
- **The plan notice:** signed, too old, replayed, older than the cached limits, and for an account that never synced.
- **Deleting:**
  - a document, an epoch, "Delete my synced data" and CoCalc's purge each leave no row and no R2 object;
  - each still works if R2 or a document object fails mid-way, then recovers;
  - sharing's data survives "Delete my synced data", and synced data survives "Delete my shared data".
- **Compaction and snapshots:**
  - a document compacted and pulled from scratch gives the same bytes, batch for batch;
  - a snapshot from a non-owner is refused;
  - "rebuild from history" doesn't need the snapshot.
- **Hibernation:** the sockets are accepted with `ctx.acceptWebSocket` (a test fails if any uses `accept()`).
- **Mutations,** each caught by a test:
  - the access-list check;
  - the owner in the document object's name;
  - the `hwm` check;
  - the epoch check;
  - the `Origin` check on the upgrade;
  - the order of the plan notice;
  - the outbox.

**The client's tests are @sagebrush-board's.** Two are shared:
- `sync-reduce`'s, run on both sides;
- a protocol conformance suite that runs the client's encoder against this server in Miniflare.

## 13. Answers to design/workspace-files.md §8.9

Those about grants and agents are answered in full in design/agent-endpoint.md §9. Here is what this server's side gives each one:

1. **Tokens:** sessions are sharing's. Agent tokens are design/agent-endpoint.md §2. The server stores only hashes of both.
2. **An in-page agent** uses the page's own session. The server can't tell it from the person, and design/agent-endpoint.md §9 says why that is acceptable.
3. **"May run code":** the server has no compute, so no code ever runs here. A remote agent's run is relayed to an open page (design/agent-endpoint.md §6). **Retention:** a write that would replace a data file whose previous version can't be kept is refused (`storage_full`), on the server as on the client (§2.5). So filling the quota on purpose can't make the server drop old bytes.
4. **Rates and sizes:** §8 for sync. An agent has its own, smaller limits (design/agent-endpoint.md §7). An over-limit agent sees 429, with `retry_after` and which limit it hit.
5. **The access log** is in the account object (design/agent-endpoint.md §8). It is deleted with the account's data.
6. **The Inbox** is design/agent-endpoint.md §9.6. On this server, an Inbox item is an entry under `/Inbox/` with a flag that keeps it read-only until a person accepts it.
7. **A collaborator's grant** never reaches the owner's files: a grant is checked against what its *granting* account may do, by the same access list (design/agent-endpoint.md §9.7).

## 14. Open questions

**For William:**
- Should sync's storage count separately from sharing's, as `sync.storage_bytes` (proposed), or share one number?
- Is the dev deployment (`dev.sagebrush.space`) the right place to try it, with test accounts only, before any production flag?

**For @sagebrush-board (the client):**
- the `Env` fields (§5.2);
- `meta.blob` for large patches;
- who sends snapshots, and when;
- the 64 KiB limit on a keepalive request when a page is hidden.
