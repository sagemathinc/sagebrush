# The sync server: backup and sync on Cloudflare

*Status: design, for review by astra (correctness), daybreak2 (limits) and William. Nothing here is built yet. When it is built, it stays behind a flag that is off in production (§11). No private user data is stored in production until William says so.*

**Changes for the client** (newest first; for @sagebrush-board's `sync-client.ts`):

| Date | Commit | What changed for the client |
|---|---|---|
| Oct 19 | (this change, §6.2) | **After a membership ends**, the account's `state` is `readonly`: every write is refused with `readonly`, the socket gets an `error` `readonly` with `purge_after`, and reading, pulling and "Download all" keep working. `GET /api/share/me` has `sync_retention: {state, readonly_since, purge_after}` (ms). The Sync panel shows the help line in web/drafts/faq-sync.md, with `purge_after`'s date. A renewal before then makes the account `active` again. (§6.2) |
| Oct 19 | (§6.1) | **One storage budget for sharing and sync.** `storage_full` now means the account's one `storage_bytes` is used, by sharing and sync together. A file upload stops at it. Document batches go on past it, into the ceiling (`max(storage_bytes / 10, 50 MB)`), and only then get `storage_full`. `GET /api/share/me` answers `usage`, the sum, and `usage_breakdown: {sharing_files, sharing_versions, sync_files, sync_documents}` (`sync_claim` in place of sync's lines if its account object can't be reached). A batch or upload can answer `busy` with `retry_after` while the budget can't be checked; retry it. (§6.1) |
| Oct 19 | (CORR-02C-1) | Turning sync on answers `{state, generation}`, and `welcome` carries `generation` too. **"Delete my synced data" must name it:** `POST /api/sync/v1/delete {"confirm": "delete", "generation": g}`, from the latest `welcome` or enable answer. Without it the request gets 400. With another generation (a request sent before sync was turned off and on again) it answers 202 with `state: "stale"` and the current `generation`, and deletes nothing. Turning sync on can now also answer 409 `conflict` (it met another change) or 503 `busy` (D1 didn't answer). Both are safe to retry. (§7.1) |
| Oct 19 | 00579315 | A batch over a document socket may now name blobs, since it is decided by the account object like any other. Presence is coalesced per socket (the latest wins, at most 10 a second), at most 4 KiB in UTF-8 bytes. Tickets are issued at a rate: 60 a minute per session, 240 per account, then `rate`. Signing out can answer 503 if the revoke couldn't be recorded; the session then stays, so try again. (§2, §5.1) |
| Oct 19 | 7962976e | A socket message may be up to 2 MiB in UTF-8 bytes (§8). The ops rate counts each op, so a message of 500 ops uses 500 of the 2,000 a minute. Over it, the whole message is refused with `rate` and `retry_after`. |
| Oct 19 | 050fb688 | **Clear history, for a stale device:** don't replace the root with your current value. Compute `merge3(acknowledged base, root, local)` and send root → result from a new client. If a record clashes, keep the local value as `<name> (conflict, <device>)`. Pins and releases are named `(doc, epoch, ref, sha256)` (server-side only). (§4.6) |
| Oct 19 | 2d2bd29c | `Env` is `{cseq, id, parents, size, blobs?}`: `cseq` counts each patchflow client's patches 1, 2, 3, …, and is sent in order from the server's `next_cseq`. A payload is the patchflow envelope without `time` and `parents`; a receiver builds patches from the returned `Env`. A large patch's blob is listed in `Env.blobs`. Ops are decided in `dseq` order with no gaps (`welcome.next_dseq`), and a refusal is final, so the client rebuilds from the server's log plus its queue. `clear` carries a root patch. Document sockets use a single-use ticket. `pull`, `index` and `blobs/check` are paged with `more`. (§4.1-4.6, §5.2, §5.4) |
| Oct 19 | cdbf420d (rebased: 5c247c5b) | `Op` gains `ref`, `fid`, `base`, and `sha256` and `size` for a data file's create or write. The device's versions stay local. `forget` and `dropVersions` are accepted from a person's session only. (§3) |
| Oct 19 | d817bede (rebased: cf06bf48) | First draft. |

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

**Why the document object's name includes the owner.** The document id is the client's own, made offline: a notebook's UUID, or a board's 12 random hex. If the name were the id alone, anyone who learned an id could claim it before the owner first synced it. With the owner in the name, two accounts can't name the same object, so the id can't be squatted. A shared document (§7.9, phase 3) is reached by naming its owner and its id. The object checks its access list.

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

**Before any object, at the Worker (LIMIT-D817-1):**
- **Nothing unauthenticated reaches an object.**
  - A sync request is authenticated by its session cookie and D1, which gives the account.
  - An agent's request is authenticated by its token's tag (design/agent-endpoint.md §2): an HMAC the server made, checked at the Worker before the token's account hash is used to name anything.
  - A request that fails either check gets 401 from the Worker, without touching any object.
- **An IP limit comes first,** independent of any account a request claims: Cloudflare's rate-limiting binding (`SYNC_PREAUTH`, keyed by IP), 60 requests a minute on `/api/sync/` and `/api/agent/`, before authentication. Over it, 429, with `retry_after` 60000 (the limit's minute).
  - A sync request that fails authentication costs one D1 read, within that limit.
  - **The binding is part of the flag** (LIMIT-321-1): with the objects bound but no `SYNC_PREAUTH`, sync is off (404).
- **An object never creates or writes storage for a request it refuses.** A refused request reads at most the rows it needs to refuse, and an account object that doesn't exist yet is created only by "turn on sync" from a session.

**Sessions:**
- A session is sharing's: the cookie, its hash, its row in D1.
- **A socket is authenticated once, at the upgrade,** by the Worker, with one D1 read. The upgrade must carry `Origin: https://<this site>`, which closes cross-site WebSocket hijacking. The socket then carries the session's hash and expiry as its attachment, so a message needs no D1 read.
- **The session is checked again from the object,** with one D1 read, when the socket next sends after 10 minutes since its last check. The session's expiry is checked on every message, from the attachment.
- **Ending a session closes its sockets at once:**
  - sign-out, "forget this device" and the purge all call the account object's `revoke(session_hash)` (for the purge: `revoke_all`), after the D1 change;
  - `revoke` records the session as revoked in `revoked_sessions` (kept until the session's expiry), deletes its unredeemed tickets, closes its account sockets, and sends `fence_session(session_hash, expires)` to each document object it gave that session a ticket for (`ticket_docs`, kept until the session's expiry). That document object records the fence durably in `session_fences`, and closes the session's sockets. `revoke` completes when every fence is acknowledged, and is retried by the alarm until then (CORR-D81-7);
  - if the call to `revoke` fails, the next check (within 10 minutes of activity) finds the session gone in D1. A socket that sends nothing can do nothing;
  - the purge retries `revoke_all` until it succeeds (§9).
- **A document socket needs a ticket, which is used once** (CORR-D81-7):
  - the account object issues it over the account socket: a random 128-bit nonce, stored in `tickets(nonce, session_hash, owner, doc, expires)`, with the expiry 2 minutes away;
  - the document object redeems it at the upgrade with one call to the account object, `redeem(nonce, doc)`. In one transaction, that call checks the ticket exists, is for this document, hasn't expired, and that its session isn't revoked, and deletes it;
  - **after `redeem` returns,** the document object checks `session_fences` again, synchronously, before it accepts the socket. It also checks on every message, from the socket's attachment:
    - a revoke whose fence arrived while the upgrade was waiting on `redeem` is therefore seen at the attach;
    - one whose fence arrives after the attach closes the socket itself;
    - both steps are in the one document object, so no order of the two leaves a revoked session attached;
  - a ticket can therefore be used once, and not at all after its session is revoked;
  - tickets are issued at a rate, whether or not they are used: 60 a minute per session, 240 per account (LIMIT-6D6-3);
  - the account object then counts the socket against the account's and the session's limits (§8, LIMIT-D817-4).
    - **The counts are leases,** in `doc_sockets(doc, session_hash, socket_id, expires)`, each 15 minutes long. The document object renews a socket's lease at its 10-minute recheck while the socket is in use, and releases it on close.
    - A lease that isn't renewed (a lost close report, or an evicted object) expires by itself. So capacity is never stranded for more than 15 minutes, and the counts are always the live leases, never a counter that can drift.

**A document socket's batches are decided by the account object** (LIMIT-6D6-1, CORR-6D6-2, CORR-6D6-3):
- the document object hands each one to the account object, which checks the session isn't revoked, applies the account's rates, pins its blobs, has the document decide it, and records the head itself;
- so a document socket is no way around any of these: a revoked session whose fence hasn't arrived yet still can't write;
- a socket may have at most 8 unanswered.

**Presence** is relayed, never stored: at most 4 KiB in UTF-8 bytes, and coalesced per socket, the latest kept, at most 10 a second (LIMIT-6D6-2).

**Revoking many documents** (LIMIT-6D6-4): a revoke sends the first 100 fences before it answers, and the alarm sends the rest a page at a time with per-item backoff. `complete` is reported once none is due. Writes are refused from the revoke's own transaction on, as above.

**Signing out** records the revoke before sharing deletes the session. If the revoke can't be recorded, the sign-out answers 503 and the session stays, rather than signing out while a socket could still write (CORR-6D6-2).

**Access to a document is checked on every message** (CORR-D81-7):
- The document object holds the access list itself (§4), so it checks the account's role on every batch, pull and presence message, without a call.
- A change to the access list (removing a collaborator, or changing a role) happens in the document object. In the same request, it closes the sockets of every account that lost access, and downgrades the attachments of those whose role changed.
- The 10-minute recheck is only for the D1 session behind a socket. It is never how access is enforced.

**State-changing HTTP requests** follow sharing's rules: they must carry `Origin` equal to the site, and be JSON or a blob PUT.

**Rate limits after authentication** are kept per account in the account object, and per document in the document object (§8). They are in memory, which a Durable Object makes exact, since one object runs one request at a time. They reset only if the object is evicted, which happens only after it has been idle, so an active abuser keeps its counters. Daily byte counters and storage are kept in SQLite, and never reset.

## 3. The account object

SQLite tables (columns abridged):

```
meta(k, v)               account_id, account_hash, generation, retired,
                          state: registering | active | readonly | deleting,
                          limits (JSON), limits_issued, limits_fetched, used_bytes, ...
devices(device, name, created, last_seen, index_cursor, session_hash, next_dseq)
ops(seq INTEGER PRIMARY KEY, device, dseq, t, by, op, path, "to", kind,
    ref, fid, sha256, size, base, recv, parent)          UNIQUE(device, dseq)
entries(path PRIMARY KEY, kind, ref, mode, size, sha256, fid, created, updated,
        trashed_from, trashed_at, by, seq)          (the index as of the last op)
docs(doc PRIMARY KEY, kind, created, bytes, head_seq, epoch, deleted)
holdings(sha256 PRIMARY KEY, key, size, refs, created)
versions(fid, n, sha256, size, t, by, device)      PRIMARY KEY(fid, n)   (§2.5)
refused(device, dseq, code)                         PRIMARY KEY(device, dseq)   (§5.2)
reservations(id PRIMARY KEY, bytes, key, expires)
pins(doc, epoch, ref, sha256, state, expires)      PRIMARY KEY(doc, epoch, ref, sha256): blobs that patches, snapshots and outputs use (§4.3)
admissions(id PRIMARY KEY, grant, gen, doc, client, first_cseq, last_cseq, state, expires)  (§4.5)
reads(day, who, bytes)                              the daily read budgets (§5.4)
outbox(key PRIMARY KEY, created)                    (R2 objects to delete)
tickets(nonce PRIMARY KEY, session_hash, owner, doc, expires)        used once (§2)
ticket_docs(session_hash, doc, expires)             where a revoke must fence the session (§2)
revoked_sessions(session_hash PRIMARY KEY, expires)
doc_sockets(doc, session_hash, socket_id, expires) leases, counted against §8's limits (§2)
grants(...), access_log(...)                         (design/agent-endpoint.md)
```

**The operation log is the index's history** (§7.2).
- The client's log (`Op` in web/workspace/api.ts on the `workspace-index` branch: `{seq, t, device, by, op, path, to, kind}`) is uploaded as it is, plus the contents' identity, which @sagebrush-board adds to `Op` with the sync client:
  - `ref`: a document's own id (a notebook's UUID, or a board's 12 hex), or a data file's key;
  - for a data file, also its `fid` (16 hex), its `sha256` and `size`, and for a `write` its `base`, the `sha256` it replaced. `base` is how the reducer tells two devices' changes to one file apart: §7.2's `name (conflict, <device>).ext`;
  - `parent` (optional, 16 lowercase hex, Oct 20): the fid of the folder the op puts something in, on `create`, `mkdir`, `adopt`, `write`, `restore`, and on `rename` and `duplicate` the destination's. It is refused on `remove`, `forget` and `dropVersions`. The server checks only its form, then stores and echoes it. What it means is the reducer's: an absent `parent`, or one naming a folder the index doesn't have, means "go by the path", so a create after another device renamed the folder lands in that folder, not in a rebuilt old path (astra's review of the reducer). An object made before the field gains the column when it next starts.
- **Ids are the client's own, and everything is keyed by (account, id).** A document object's name includes its owner (§1), and every table is per account. So a collision across accounts is impossible, and one within an account (48 random bits for a board) is negligible. The server checks each id's form: a UUID, 12 hex or 16 hex.
- **The op names:**
  - `create`, `mkdir`, `write`, `rename`, `remove`, `restore`;
  - `adopt` (migration and recovery) syncs as a `create`;
  - `forget`: the page deleting a notebook outright, before Trash has a UI. It removes the entry and its contents, as emptying Trash does for it, so it is accepted only from a person's session, never from a grant;
  - `dropVersions`: from a person's session only (below).
- **Decided once, by `(device, dseq)`,** where `dseq` is the device's own `seq`. A device's ops are decided in order, with no gaps (`devices.next_dseq`): every op below it was accepted (it has a `seq`) or refused (its code is in `refused`), and a resend gets the same answer (§5.2).
- The server gives each op it accepts a `seq` of its own. **The server's order is the order of the log:** every device applies the ops in `seq` order, so all of them reach the same index.
- **One reducer.** The conflict rules of §7.2 (the later rename wins; an edit after a delete brings the file back out of Trash; a second new file at a path becomes `name (2)`) are one pure function, `reduce(entries, op) -> entries'`. It lives in `web/workspace/sync-reduce.ts` and is used by the client and by the server, with one test suite, so they can't disagree.
- `t` is the device's clock, shown to the person, and never used for order.
- The server keeps `entries`, the result, because it needs paths: for quota, for an agent's scope (design/agent-endpoint.md), and to answer `list` while every device is closed. §10 says what this means for end-to-end encryption.
- **Checked when applied:** the path (`normPath`'s rules, with the same tests as the client), the kind, the size, and that a referenced blob is held (`refs` + 1 in the same transaction) or a document is the account's. An op that fails a check is refused with its code, and is never in the log. The ops after it still apply, each as the reducer would apply it if the refused op had never been sent (a rename of a path that isn't there changes nothing). The client then takes the server's log as the truth, and rebuilds its index from it.

**Data files' versions (§2.5): the device's own versions stay on the device** in phase 1 (@sagebrush-board): they aren't uploaded. **The server keeps versions of its own:**
- An overwrite the server sees (a `write` that replaces a data file's `sha256`) keeps the old blob as a version, in the same transaction.
- Without this, the old blob would lose its last reference and be deleted. An agent's overwrite through the endpoint, while every device is closed, would then lose bytes, which §8.3 rules out.
- Overwrites made between two syncs on one device have their versions only on that device.
- The client's retention rules apply, in the reducer: the latest 20, none older than 30 days, and all together at most `sync.version_bytes`. Versions count against the quota.
- If storage is too full to keep the previous version, the `write` is refused with `storage_full`, as on the client (§13).
- Trash's bytes sync, as the blob of the entry in Trash.
- `dropVersions` from a person's session drops the server's versions too. A grant can't send it (design/agent-endpoint.md).

**A blob's references:** an entry, a version, and a pin (a patch's blob, a snapshot, an outputs value: §4.3). When a holding reaches `refs = 0`, it goes into the outbox in the same transaction. A holding with no reference at all, a day after its upload, is unused and goes into the outbox too. The account object's alarm empties the outbox: it deletes the R2 object, and only then the row.

**Usage** (`used_bytes`) is kept up to date in the same transaction as each change: holdings, plus the document objects' bytes (each batch reports its size back), plus running reservations. It is never a `SUM` over a table. A daily recount from the tables corrects drift, and logs any it finds.

## 4. The document object

```
meta(k, v)        owner_hash, owner_account, doc, kind, created, epoch, head_seq, bytes
acl(account, role)                          owner; editors and viewers in phase 3
batches(seq INTEGER PRIMARY KEY, epoch, author, writer, device, recv,
        envs TEXT, body BLOB, blobs TEXT)   one row per batch: its checked envelopes, its payloads, its blobs
clients(client PRIMARY KEY, writer, next_cseq)
ranges(client, first_cseq, last_cseq, first_id, last_id, seq, ids TEXT)
                                            PRIMARY KEY(client, first_cseq); INDEX(client, first_id)
segments(first_seq, last_seq, key, bytes, blobs TEXT)  older batches, moved to R2
snapshots(at_seq, key, sha256, bytes, by, t)
outputs(cell, sha256, size, by, t)          (§7.2: the latest outputs, by hash)
fenced(admission PRIMARY KEY, expires)      grant writes cancelled before they commit (§4.5)
releases(epoch, ref, sha256)                blobs to release in the account object, until it acknowledges
session_fences(session_hash PRIMARY KEY, expires)   revoked sessions this document was told of (§2)
outbox(key PRIMARY KEY, created)
```

**The writes per batch:** one `batches` row, and one `ranges` row for each patchflow client in the batch (almost always one). `clients` is updated in place. A patch is never a row of its own, since a row per patch would cost about 30 times more (§7.3).

### 4.1 Framing: checked graph, opaque payloads (CORR-D81-2)

A batch is a list of envelopes and a body:
- **An envelope:** `Env = {cseq, id, parents, size, blobs?}`, one for each patch, in order. The server checks it and returns it.
- **The body:** the patches' **payloads**, concatenated in that order. The payload of patch *i* is bytes `[Σ size_<i, Σ size_≤i)`, and the sizes must add up to the body's length.
- **A payload is a patchflow envelope without its graph fields:** no `time`, no `parents`. These are opaque bytes to the server, which never parses them (§10).
- **A receiving client builds each patch** as `{...payload, time: Env.id, parents: Env.parents}`, from the envelope the server returns. A payload that holds `time` or `parents` itself is treated as corrupt and not applied, so the graph a client applies is always the one the server checked.
- **The author isn't in the payload's trust:** the batch row's `author` and `writer` are set by the server (from the session, or the grant's admission) and returned beside the envelopes. A payload's own `userId` or `meta` is never taken as who wrote it.

### 4.2 Exact membership, without a row per patch (CORR-D81-1)

- **Each patchflow client numbers its patches 1, 2, 3, …** That number is `cseq`, kept with each patch in the device's outbox, and never reused. patchflow's ids also increase for one client (`Session.nextTimeMs`, session.js:591), but ids have gaps, so they are checked, not trusted for membership.
- **The server keeps `clients.next_cseq`**, the number it expects next. A patch is accepted only in order, so every `cseq` below `next_cseq` was accepted, and none at or above it was: membership is exact.
- **A batch, for each client in it:**
  - its patches' `cseq` are consecutive, and their ids strictly increase;
  - the first patch with `cseq ≥ next_cseq` has exactly `next_cseq`. A gap is refused whole, with `order`, and the client resends from `next_cseq`, which the refusal says;
  - patches below `next_cseq` are resends. Each is looked up in `ranges` (the row whose range holds its `cseq`), and its id must be the id stored there. If it is, the resend is dropped and acknowledged with its original `seq`. If not, the batch is refused with `conflict`: a client reused a number for another patch;
  - a new client's first `cseq` is 1.
- **A client is bound to its writer:** the first batch from a `client` records its writer (`session:<device>` or `grant:<id>`), and a batch from another writer naming that client is refused with `forbidden`.
- **Every parent must be accepted, exactly:** a parent is either earlier in the same batch, or found in `ranges`. The parent's client gives the client, its id gives the row (ids increase with `cseq`, so the ranges are in id order too), and that row's `ids` must hold it. Otherwise the batch is refused with `order`.
- **A mixed resend,** some patches old and some new, is stored as only the new ones: the server slices their payloads out of the body by the envelopes' sizes. It never parses them. The old ones keep their original row, `seq` and author.
- **`ranges` is kept for the epoch's life,** since a pruned range would make a late resend look new. The epoch empties it with `clients`.

### 4.3 Blobs in patches are visible, and pinned (CORR-D81-3)

- **A patch over 256 KiB** goes up as a blob first. Its envelope then lists the blob in `blobs`, and its payload refers to it in whatever way the client chooses.
- **The account object pins every listed blob before it forwards the batch:**
  - in one transaction, it checks that each blob is held, adds a reference, and records a pin `(doc, epoch, ref, sha256)` as `pending`;
  - **a pin's identity can't recur** (CORR-D81-3):
    - `ref` is `patch:<client>:<cseq>`, `snapshot:<at_seq>` or `outputs:<cell>:<seq>`, and `epoch` is the document's epoch;
    - a clear starts a new epoch, and the server's `seq` never repeats, so no later pin has the identity of an earlier one, even for the same grant's client and `cseq`;
    - a release names the full identity, so a late release of an old pin can only remove that pin;
  - it forwards the batch with `pin_expires`, 5 minutes away;
  - the document object refuses a batch after its `pin_expires`, so a delayed forward can't commit after its pin is given up;
  - when the document object answers, the pin is `held` (accepted, or a resend of an accepted patch) or released (refused);
  - a pin still `pending` a minute after `pin_expires` (the answer was lost) is settled by asking the document object which `cseq` it has for that client.
- **A batch row lists its blobs,** and so does a segment made from it, so compaction and exports keep them.
- **When history is dropped** (the epoch, or the document deleted), the dropped rows' blobs go into `releases` in the same transaction. The document object then calls the account object's `release` until it acknowledges. `release` is idempotent, by the pin's full identity `(doc, epoch, ref, sha256)`.

### 4.4 Compare-and-swap on the head (CORR-D81-4)

- A batch may carry `expect_head: {epoch, seq}`.
- In the transaction that would store it, the document object checks that its head is exactly that. If it isn't, the batch is refused with `conflict` and the current head.
- **A lost acknowledgement is told apart from a stale base:** a batch whose patches are all resends of accepted ones (§4.2) is acknowledged with their original `seq`, whatever the head is now. Only a batch with new patches is checked against `expect_head`.
- Devices don't send `expect_head`: their concurrent edits merge, as patchflow's do. The agent endpoint's `write` always sends it (design/agent-endpoint.md §4).

### 4.5 Grant writes: admission and fence (CORR-D81-5)

A grant's write spans two objects: the account object holds the grant, and the document object commits the patch. They can't share one transaction, so the order between them is made explicit:

1. **Admission.** In one transaction, the account object checks the grant (live, its `gen`, and the scope against the index as it is now), writes an access-log row (`admitted`), and records an admission `{id, grant, gen, doc, client, cseq range, expires: now + 60 s}`.
2. **The forward** carries `admit: {id, expires}`. The document object refuses it if its `id` is in `fenced`, or if it is past `expires`. Otherwise it commits.
3. **The answer** completes the admission, and the log row becomes `committed` or `refused`, with the `seq`.

**What cancels an admission:**
- revoking the grant;
- narrowing its scope, or turning off `run_code`;
- a rename or remove that takes its document out of the grant's scope.

**How it cancels:**
- the change and the cancellation are one transaction in the account object, which marks each pending admission of that grant (or that document) `cancelling`;
- the account object then sends `fence(admission ids)` to each document involved;
- the document object adds them to `fenced` (kept until their `expires`) and answers with what it already committed. An admission committed before its fence stays committed, and is logged as such;
- **the change is complete** when every fence is acknowledged, or at most 60 seconds later, when every admission it cancelled has expired. The panel shows "Revoking…" until then.
- **So no write admitted before a revoke can commit after the revoke completes,** and none can be admitted after the revoke's transaction.
- **A lost answer** is settled the same way as a pin (§4.3): after `expires`, by asking the document object.

### 4.6 The epoch: "Clear history" keeps the document (CORR-D81-6)

- **What the person's page sends:** `clear {expect_head, root}`, where `root` is a batch of one patch with no parents: the document's current value, as one patch from empty. It comes from a person's session only, never a grant.
- **In one transaction,** the document object:
  1. checks its head is `expect_head`, or refuses with `conflict`;
  2. raises `epoch`;
  3. moves every older batch, segment, snapshot and output to the outbox, and their blobs to `releases`;
  4. empties `clients` and `ranges`;
  5. stores `root` as the first batch of the new epoch, whose head it becomes.
- **So the document is never without a value:** a device that opens it after the clear, even one that never saw it before, gets the root. Old history is gone.
- **A device still in the old epoch:**
  - its batches are refused with `epoch`, giving the new epoch and head;
  - it drops its local history, and pulls the root;
  - **it rebases only its own unsent changes onto the root** (CORR-D81-6):
    - its *acknowledged base* is the value of the patches the server accepted;
    - its *local value* is that plus its unsent patches;
    - it computes `merge3(base, root, local)` with patchflow's codec (`DocCodec.merge3`), and sends one patch from the root to the result, from a new patchflow client;
    - so the root's changes (someone else's `x1`) stay, and only the device's own (`y1`) are applied over them;
    - if `merge3` can't merge a record cleanly, the root stays as the document, and the device's local value is kept as `<name> (conflict, <device>)`, a document of its own. Nothing is reverted silently;
- **Its old patches can't come back,** since the server refuses the old epoch.

### 4.7 Snapshots

Snapshots bound the replay for a new device (§7.2).
- **A snapshot is made by a client,** because only a client can read the payloads:
  - the client holds the document at batch `at_seq`;
  - it uploads the snapshot as a blob, and registers `{at_seq, sha256, bytes}`;
  - the blob is pinned as a patch's blob is (§4.3);
  - the server checks only that `at_seq` is a batch of the current epoch, and that the blob is held.
- **Who may make them:** only the owner's sessions, because a snapshot is trusted by every device that opens from it. In phase 3, a collaborator's snapshot would be a way to show the owner a document that differs from its history.
- **A snapshot never replaces history.** The batches stay (TimeTravel shows every version), and a device can always rebuild from the batches alone. "Rebuild from history" in the Sync panel does exactly that, and checks the result against the snapshot.
- **When:** the client offers one after 500 batches or 4 MB of patches since the last snapshot. The server keeps the latest 3.

### 4.8 Compaction, outputs, exports

**Compaction moves old batches to R2,** so a document object stays small however long its history:
- every batch older than the latest snapshot, beyond the latest 200, is concatenated into a segment object in R2 (`s/<hash>/<random>`), with each batch's envelopes, author and blobs. The bytes are copied, never parsed;
- in one transaction, the segment row is written, with the union of its batches' blobs, and those batch rows are deleted. `ranges` stays, so membership is unchanged;
- the document object's alarm does this when it is awake anyway, at most once an hour;
- the order of steps is: the segment goes to R2, then the transaction. A crash between the two leaves an R2 object nothing references, which the daily inventory (§9) finds.

**Outputs** (§7.2): a map from cell id to the blob of its latest outputs. The latest write wins, in the server's order. Each value refers to a held blob, pinned like any other (§4.3).

**Exports for backups off Cloudflare** (sharing.md "Backups"):
- once a day, if anything changed, the document object writes its batches since the last export as one more segment;
- the account object writes its `entries`, `ops` and `versions` as one export object;
- so everything an account has is in R2 within a day, where sharing's off-site copies already go;
- the Durable Objects' own point-in-time recovery (30 days) covers the hours in between.

## 5. The protocol

Version 1: JSON messages over WebSockets, plus HTTP for blobs and for the case where a socket can't be used. The client is @sagebrush-board's.
- Every field is listed here, and nothing else is accepted. An unknown field is a 400, because a field the server ignores today could change meaning tomorrow.
- **Every collection has a hard bound** on items and encoded bytes, with a cursor and `more` (LIMIT-D817-4), as listed in §8.

### 5.1 Connections

- **The account socket.** One per device, always open while the page is, at `GET /api/sync/v1/account` (upgrade).
  - It carries the index, the batches for documents nobody else has open, and the notifications that a document changed elsewhere.
  - It uses the hibernation API (§7.3).
- **A document socket,** at `GET /api/sync/v1/doc/<owner>/<doc>?ticket=…` (upgrade). The ticket is used once (§2).
  - It is opened only while another device or person also has the document open. The account object says when: it sends `watching`.
  - Batches then go to it at once, not every 30 seconds, and presence rides on it without being stored (§7.9).
- **HTTP, for when a socket isn't open:** `POST /api/sync/v1/batch`, with the same body as a socket's `batch`.
  - This is for a page being hidden or closed (`fetch(…, {keepalive: true})`), and for an agent (design/agent-endpoint.md).
  - A keepalive request's body is at most 64 KiB, so the page sends what fits, and the rest goes when it opens again.

### 5.2 The account socket's messages

Client to server:

```
{t: "hello", v: 1, device, name, index_after: seq, docs: [{owner, doc, after: seq}], account?, generation?}   docs: at most 1,000
{t: "ops", req, ops: [{dseq, t, by, op, path, to?, kind, ref?, fid?, sha256?, size?, base?}]}
{t: "pull_index", req, after: seq}
{t: "batch", req, owner, doc, epoch, kind?, expect_head?, patches: [Env], body: base64}
{t: "pull", req, owner, doc, epoch, after: seq, limit?}
{t: "clear", req, owner, doc, expect_head, root: {patches: [Env], body}}
{t: "ticket", req, owner, doc}
{t: "snapshot", req, owner, doc, at_seq, sha256, bytes}
{t: "outputs", req, owner, doc, set: [{cell, sha256, size}]}   set: at most 500
```

Server to client:

```
{t: "welcome", v: 1, state, limits, used_bytes, index_head, next_dseq, server_time}
{t: "ack", req, ops?: [{dseq, seq} | {dseq, code}], batch?: {seq, new, resent, head}}
{t: "index", req?, ops: [... with seq], more}        at most 1,000 ops and 1 MiB; then pull_index
{t: "changed", owner, doc, head: {epoch, seq}, by_device}
{t: "watching", owner, doc, n}
{t: "batches", req, owner, doc, epoch, items: [{seq, author, writer, device, patches: [Env], body}],
               snapshot?: {at_seq, sha256}, more}    at most `limit` (default 100, at most 500) and 4 MiB
{t: "ticket", req, ticket, expires}
{t: "error", req?, code, detail}
{t: "revoked"}                                        followed by close 4401
```

- **The client's binding** (CORR-PR58-1): `hello`'s `account` (the account's hash) and `generation` name the namespace whose outbox the client sends. If either isn't this account object's, hello is refused (`forbidden`, reason `account`; `conflict`, reason `generation`) and nothing is sent on the socket. A socket whose session switched to another account between the page's discovery and the upgrade is refused this way. Blob requests carry the same binding as headers (§5.4). **Both are optional in v1: absent means unbound** (accepted, as before the binding). The step-3 client always sends both. A later version can make them mandatory once no unbound client remains.
- **`Env`** is `{cseq, id, parents, size, blobs?}` (§4.1).
  - The author isn't in it. The server sets the author from the session, or from the grant's admission, and never takes it from the client (§7.10, §8.7).
  - A receiving client builds each patch from the returned `Env` and its payload slice, and refuses a payload that holds its own `time` or `parents`.
- **`pull`** answers with batches after `after`, in the epoch the client names.
  - If the client's epoch is old, it gets `epoch`, with the current epoch and head (§4.6).
  - If `after` is older than the latest snapshot, and older than the batches still in the object, it gets the snapshot and the batches since it.
  - Segments are read from R2 only for TimeTravel's "load more history", at most one segment per request.
- **`ops`:**
  - **A device's ops are decided in `dseq` order, with no gaps.** The server keeps `devices.next_dseq`. An op with a `dseq` above it is refused, along with the rest of the message, with `order` and `next_dseq`.
  - **Every op below `next_dseq` has been decided, once and for all:**
    - accepted, with its `seq`;
    - or refused, with its code, which `refused(device, dseq, code)` keeps.
    - A resend gets the same answer, and a refused op never becomes accepted later.
    - Refusals are rare. A device that collects 10,000 of them is answered `invalid` and must rebuild from the server's log.
  - **What a client does with a refusal:**
    - it removes the refused op from its queue;
    - it rebuilds its index as the server's log, plus the ops it still has queued, reduced in order by the shared reducer;
    - the ops after a refused one were applied by the server in the same way (§3), so the client and the server agree.
- **Every `req`** is the client's number, echoed in its answer. A client may have at most 8 requests unanswered on a socket. Beyond that, the server answers `busy`.
- **Codes** that answers use:
  - `invalid`: the shape;
  - `exists`, `missing`, `conflict`: the index rules, and §4.2 and §4.4;
  - `order`, `epoch`, `unknown_doc`, `forbidden`;
  - `limit`: a size, with `detail` saying which;
  - `storage_full`;
  - `rate`: with `retry_after`;
  - `readonly`, `deleting`, `busy`.

### 5.3 Batches

- **A batch is the patches of one document,** at most 1 MiB of body and 2,000 patches, so it fits in one SQLite row (2 MB at most, §7.8).
- **When batches are sent:**
  - when nobody else has the document open, every ~30 seconds, and at once when the page is hidden;
  - over a document socket, as patches are made, at most 4 a second.
- **What happens to a batch:**
  1. The account object pins its blobs (§4.3), or admits a grant's write (§4.5).
  2. It forwards the batch to the document object, which checks it (§4.1-4.4), stores it, and answers with its `seq` and head.
  3. The account object settles the pins, updates `docs.head` and `bytes`, and sends `changed` to the account's other devices.
  4. That is one call between the objects.

### 5.4 Blobs

```
POST /api/sync/v1/blobs/check   {blobs: [{sha256, size}]}  -> {missing: [sha256]}   at most 1,000
PUT  /api/sync/v1/blob/<sha256> the bytes (Content-Length required)
GET  /api/sync/v1/blob/<sha256> -> 303 to a signed URL on the user-content domain
```

A client's `blobs/check` and `PUT` carry `x-sync-account` (the account's hash) and `x-sync-generation`. If either isn't the account object's, the request is refused (403 `forbidden`, 409 `conflict`) before anything is reserved, stored or answered, so bytes queued for one account never land in another's under a switched session (CORR-PR58-1). As in hello, an absent header means unbound; the step-3 client always sends both.

**Uploading follows sharing's steps:**
1. The account object reserves the bytes with one conditional write against the limit (`max_file_bytes`, and `sync.storage_bytes` minus usage), with a random R2 key, for at most an hour.
2. The Worker streams the body to R2, with the SHA-256 for R2 to check. The stored size must equal the declared one.
3. **Finalizing is idempotent:**
   - the account object deletes the reservation and, if no holding for that SHA-256 exists, makes one with this key and `refs = 0`;
   - if one already exists (two uploads of the same bytes at once), this upload's object goes to the outbox instead;
   - a holding counts in usage once something refers to it, or goes to the outbox after a day unused (§3).
4. **A reservation that expires** (its upload died) is reaped by the alarm: the row goes, and its key goes to the outbox unless a holding uses it. An R2 write that lands after that is found by the daily inventory (§9).

**Reading, and what it costs** (LIMIT-D817-3). Uploaded bytes are never served from sagebrush.space (sharing.md, "Serving"). A read is a signed URL on the user-content Worker, and **what is metered is the bytes authorized, at the moment a URL is issued**:
- **Issuing a URL debits the blob's whole size from a daily read budget** in SQLite: the account's (for the person's devices, `sync.read_bytes_per_day`), or the grant's (design/agent-endpoint.md §7). If it doesn't fit, it is refused with `rate`.
- **A device's URL** (HMAC, key `SYNC_URL_KEY`) is good for 5 minutes and for ranges, so code that reads part of a large file downloads only that part. Fetching it again within those 5 minutes is deliberately outside the budget. The files Worker bounds it by IP (rate-limiting binding, 600 requests a minute) and by the URL's expiry.
  - **The URL carries its expiry** as the query parameter `exp`, in milliseconds since the epoch. The client reads it from the followed redirect's final URL and reuses that URL for the item's retries until then, less a margin (design/sync-client.md, "A signed URL is kept, with its expiry"). A URL without `exp` is never reused: the client asks for a fresh one at each attempt.
- **A grant's URL is used once:**
  - it carries a random nonce, which the files Worker redeems from the account object (one call) before serving;
  - one request, which may be a range;
  - so a grant's bytes read are at most its debits.
- **What the files Worker serves**, as it serves shared files: an attachment, `nosniff`, `default-src 'none'; sandbox`, `private`, and CORS for sagebrush.space.
- Single files are at most 95 MB until multipart uploads exist (as sharing's, §7.8).

## 6. Limits from cocalc.ai, and the plan notice

**The limits** are sharing's call, `GET /api/v2/sagebrush/limits?account_id=…`, with one more field for sync: `{storage_bytes, max_file_bytes, private_links, sync: {enabled, version_bytes, read_bytes_per_day, retention_days}}` (`retention_days` is optional, 90 if absent, §6.2). `storage_bytes` is the one budget for sharing and sync together (§6.1). A `sync.storage_bytes` CoCalc may still send is ignored.
- **Whether a plan includes sync** is `sync.enabled`, a boolean in CoCalc's editable membership tiers, not a constant here. By default the free tier has it off (abuse risk) and every other tier on. It is CoCalc's config; this server only reads it. CoCalc decides the numbers per membership; they are not in this repository (sagebrush/business-material-out-of-repo).
- **They are cached in the account object for 6 hours,** not 10 minutes (§7.3). With 100,000 accounts active, that is about 5 requests a second to cocalc.ai.
- **When the cache is old,** the limits are fetched again, and the cached value is used while the fetch runs.
- **If CoCalc can't be reached,** the cached value is kept, however old. With nothing cached, uploads are refused and document batches are still accepted (below). An outage is never read as zero, or as no limit.

**The plan notice:** `POST /api/admin/limits`, from cocalc.ai, when an account's plan changes.
- The body is `{request_id, account_id, issued, limits}`.
- It is signed the way the purge request is: HMAC-SHA256 over the timestamp, method, path and body, at most 5 minutes old. The key is a separate one, `LIMITS_KEY`, so a leaked limits key can't purge, and the reverse.
- **It is applied only if `issued` is newer** than the cached value's. So a notice that is replayed, or arrives late, can never undo a newer one. A fetch also records the issue time CoCalc returns.
- **For an account that never turned on sync,** the notice is a no-op: 200 with `{applied: false}`. Nothing is created for it.

**What the limits do:**
- **Over `storage_bytes`** (sharing and sync together, §6.1):
  - file uploads, sharing's and sync's, stop with `storage_full`, and the page says so;
  - **document batches keep being accepted,** since edits are small (§7.4), up to a named ceiling: `storage_bytes` plus `max(storage_bytes / 10, 50 MB)`. Beyond the ceiling they are refused with `storage_full`, and wait on the device;
  - nothing already synced is removed, and nothing is removed on a downgrade either.
- **`sync.enabled` false** (the plan no longer includes sync): the account becomes `readonly`.
  - Nothing is deleted.
  - Every write is refused with `readonly`.
  - Reading, pulling and "Download all" keep working.
  - The page says why (§7.4).

### 6.1 One storage budget for sharing and sync

William's decision (Oct 19): one `storage_bytes` covers sharing and sync together, and the user sees what each part holds.

**The invariant:**
$$\text{sharing} + \text{sync} \le \text{storage\_bytes} + \text{ceiling}, \qquad \text{ceiling} = \max(\text{storage\_bytes} / 10,\ 50\ \text{MB}),$$
where only sync's document batches ever use the ceiling. Sharing, and every file upload, stop at `storage_bytes`.

**How (an escrow):**
- D1's `sync_accounts.claim_bytes` is the most sync may use. Only the account object changes it.
  - **Raise:** one conditional statement per cap. The claim grows by $\min(\text{whole chunks}, \text{cap} - \text{claim} - \text{sharing})$, where `sharing` is sharing's own SQL for the account's bytes, as long as that covers what is short. So the last part below a cap is taken in one write, never one an edit (LIMIT-97A-1). $C = \min(\text{clamp}(\text{storage\_bytes}/64,\ 4\ \text{MiB},\ 64\ \text{MiB}),\ \text{storage\_bytes})$. A file raise uses `cap = storage_bytes`; a document raise tries that first, then `storage_bytes + ceiling`.
  - **Full:** a raise refused for space isn't asked of D1 again, for that kind, for 60 s, or until the limits change. Meanwhile the refusal is `storage_full` with `retry_after`, the time left, so a client can tell "full, try again shortly" from "full". A full budget costs at most one D1 statement a minute per cap: one for files, up to two for documents (`storage_bytes`, then the ceiling). Never one an edit.
  - **Unusable grants are given back:** a raise D1 granted, answered after new limits, installs D1's claim but no caps, and arms the alarm. So does a new limit from a notice or a fetch. The alarm gives back slack beyond $2C$, with no further request needed (CORR-BDA-1).
  - **After every await:** nothing D1 answered is installed unless the account is still the same generation, not deleting (CORR-97A-1). The caps aren't restored if the limits changed meanwhile, a revision counted with every new `storage_bytes` (CORR-97A-2). A queued raise reads the current limit when it runs, not the one it was queued with.
  - The raise names the account's generation and requires `state = 'active'`, so a dead or deleting generation can't raise.
- **Sharing's check counts the whole claim:** its reservation is one INSERT with `sharing + claim + new ≤ storage_bytes`. Once documents have taken sync into the ceiling, `sharing + claim > storage_bytes` already, so sharing refuses even one byte. It is a plain integer comparison in SQLite, with no wrap and no clamp to zero.
- **Sync's check is local:** `files + documents + held + new ≤ cap`.
  - `cap` for files is `blob_cap`: the claim as of the last time D1 found `sharing + claim ≤ storage_bytes`, lowered by every release. So files stop at `storage_bytes` even when documents hold claim in the ceiling.
  - `cap` for documents is `doc_cap`, the same, as of the last raise.
  - A new `storage_bytes` (a fetch or a notice) sets both caps to 0, so the next write has D1 check the claim against it again. A downgrade takes effect at once.
- **Batches are held:**
  - a batch's body is exactly what its document's total can grow by (a resend grows it by less), so its bytes are held, `batch_holds`, from admission until the document answers;
  - at most 200 holds are open per account, as many as a document's live batches. Past that, a new batch gets `busy` with `retry_after`, so a stream of lost answers can't grow the table (LIMIT-97A-2);
  - a refusal before the forward (a blob not yet uploaded, when pinning) gives the hold back at once. Any failure after the forward began, with the hold still open, wakes the alarm for it (CORR-97A-3);
  - the answer's total then replaces the hold, in one step;
  - a lost answer's hold stays until its attempt can no longer commit (its pins' lapse). The alarm then asks the document its total (`info()`, bounded at 2 s), which replaces the hold.
- **Ordering:** every raise and release goes through one chain in the account object, so its claim is never above D1's. A raise writes D1 first, then the object's value (from `RETURNING`). A release lowers the object's value first, then D1. A release that D1 misses is retried from the alarm with backoff; until then D1 is only higher, so room goes unused, never overshot.
- **Release:**
  - the alarm gives back slack beyond $2C$, keeping $C$;
  - **at sharing's edge:** a sharing upload refused for space asks the account object, once, to give back everything it doesn't use, and tries once more. If the object can't be reached, or its give-back can't reach D1, the refusal stands: never fail open.
- **Purge:** the purge's D1 record sets `claim_bytes = 0` for its generation (and for older ones). A new generation's registration starts at 0. So the space returns to sharing.

**Bounds:**
- **Overshoot:**
  - none beyond the invariant: each side's check is one serialized D1 statement, and sync never uses more than D1 granted;
  - sharing and files never exceed `storage_bytes`;
  - documents exceed it only into the named ceiling.
- **Under-use:** at most about $2C$ a person, which shows as free in the breakdown. Sharing's release-and-retry recovers it at the edge.
- **D1 writes:** one per chunk of growth, one per tail below each cap (`storage_bytes`, then the ceiling), plus one per release. When full, at most one statement per kind a minute. Never one per edit. In the tests:
  - 20 batches of 1,000 bytes on a 1 MiB budget made at most 3;
  - with production's chunk and less than one left, 11 edits made 2 writes, and further refused edits made none.

**The breakdown** (`GET /api/share/me`): `usage` is the sum, and `usage_breakdown` has `sharing_files`, `sharing_versions`, `sync_files` and `sync_documents` (sync's versions will join them, §3). Sync's lines come from a read-only account-object call. It is for display only: enforcement is the claim.

**Without a known limit** (CoCalc unreachable, nothing cached): writes that fit the claim already held go on; anything needing a raise answers `busy` with `retry_after`, never `storage_full` and never unlimited.

### 6.2 After a plan stops including sync

(Oct 25 wording: this section applies when the account's plan no longer includes sync, that is `sync.enabled` is false: a tier without sync, or an admin change. A membership ending to a tier that still includes sync, such as free once its sync is on, doesn't end sync. Over that tier's `storage_bytes`, new files stop uploading, document edits keep syncing, and nothing is deleted (§6.1; William, Oct 25).)

William's decision (Oct 19): read-only, then deleted after a retention period, with email first.

- **The period is CoCalc's:** `sync.retention_days` in its limits, 90 if it says nothing. In code it is read from the limits, never a constant there.
- **The plan is read before sync is turned on** (CORR-445-2, and the enable change of Oct 19, from the dev smoke test).
  - `POST /api/sync/v1/enable` asks CoCalc for the plan first:
    - a plan without sync gets 403 "sync isn't available for this account", with nothing registered;
    - CoCalc unreachable, or answering without the `sync` block, gets 503 `busy` "CoCalc can't be reached to check this account's plan; try again", with nothing registered;
    - otherwise the account registers, keeping that plan.
  - An account already on refreshes its plan first, so enable answers `readonly` once the plan has ended, and `busy` while nothing is known. It never answers `active` for an account whose plan isn't known.
  - **`GET /api/sync/v1/status`** is the page's question before it shows its switch. It answers `{available, reason?, state, generation?}` and never creates or registers anything:
    - off the allowlist: `available: false`, reason `not_allowlisted`, answered by the Worker without asking the account object. The page hides its switch then; the reason is for the page's logic, not to show;
    - an account never synced: answered from CoCalc's plan, asked and stored nowhere. The answers are `available: true` with `state: "off"`, or `available: false` with reason `plan_has_no_sync` or `cocalc_unreachable` (with `retry_after` 5000);
    - **CoCalc is asked at most once at a time per account object** (LIMIT-SYNC-STATUS-1). Concurrent statuses and an enable share one in-flight fetch. A plan CoCalc gave is kept in memory for a minute, for status only. After CoCalc couldn't answer, it isn't asked again for that account for 5 s, and an enable in that time is `busy` at once. So polling through an outage costs CoCalc one request per account per 5 s;
    - CoCalc deleted the account: reason `deleted`;
    - an account on: `available: true` with its `state` (`registering`, `active`, `readonly`, `deleting`) and `generation`.
  - The confirm applies the plan enable kept (fetched again only if it's old). A plan that ends in between arrives as CoCalc's notice, and makes the account `readonly` before any write. A batch or a clear checks the account again after every wait (the room for it, which may fetch the plan), before anything is held or sent. If CoCalc can't be reached at enable, the plan is fetched before the first write that needs room.
- **When a plan stops including sync** (a notice, or a fetch, saying `sync.enabled: false`):
  - the account becomes `readonly`, and every write is refused with `readonly`;
  - it records, once: `readonly_since`, the time CoCalc says the plan changed (the notice's `issued`, never later than now); the time sync learned of it; and **the deadline, fixed then** (CORR-445-1):
    $$\text{purge\_after} = \max(\text{readonly\_since} + \text{retention\_days},\ \text{received} + 14\ \text{days})$$
    CoCalc's time is authoritative, but a late notice never deletes without warning: there are always 14 days for the two emails (@sagebrush's rule, Oct 19). Later limits, a longer or omitted `retention_days` included, never move it;
  - its sockets are told, with the deadline.
- **Renewed before the deadline** (`sync.enabled: true` again, judged against the stored deadline, not one recomputed from the new plan): the clock is cleared, and the account is `active` again. A renewal at or after the deadline doesn't stop the deletion.
- **At `readonly_since + retention_days`,** plus a delay of 0 to an hour fixed per account by its hash (never before the deadline), the account object's alarm, armed for that time, runs the same purge as "Delete my synced data", with the same steps, fences and D1 record.
  - The delay spreads a mass lapse, so accounts aren't all purged at once. `purge_after`, the deadline the person and CoCalc are told, is unchanged, and "deleted after 90 days" stays true.
  - The boundary counts as past: at the purge time exactly, the purge starts.
- **Every purge step is bounded** (LIMIT-445-1): at most 200 expired reservations, 500 holdings and 1,000 pins a step, as well as the existing 50 documents, 500 outbox keys and 1,000 listed R2 keys.
  - A step that stops at a full page runs again after 250 ms at the least, so one account's purge makes at most 4 steps a second: 800 reservations, 2,000 holdings or 4,000 pins a second (daybreak2, @sagebrush's pace).
  - Otherwise the alarm waits its usual 30 s.
- **Late and repeated notices:** limits apply only if newer than those held (`issued`). So a repeated notice never resets the clock (`readonly_since` is set once), and a late one never ends it.
- **What the person sees:** `/api/share/me` has `sync_retention: {state, readonly_since, purge_after}`, and the Sync panel says it (the help line in web/drafts/faq-sync.md). The FAQ entry is drafted there too, unpublished until sync opens beyond its test accounts.
- **Emails are CoCalc's** (it has the address and the mail system). This server sends none. The hook:
  - `GET /api/admin/sync-retention/<account_id>`, signed with LIMITS_KEY, answers `{state, readonly_since, purge_after, now}`. `purge_after` is the stored deadline above. A 404 means the account holds no synced data now: it never synced, or it was purged (a tombstone);
  - after sending the notice that ends a plan's sync, CoCalc reads it, sends the first email with `purge_after`'s date, and schedules a second for about 14 days before `purge_after`;
  - before sending each, it asks again, and sends nothing if `readonly_since` is null (renewed) or the state is no longer `readonly`.

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
4. Everything is dropped, leaving a tombstone (§7.1). The D1 row `sync_accounts` is then marked `purged`, with counts and no id (as sharing's purge records are).

**What happens to sync while it is being deleted:**
- A device that is online is told `deleting`, and stops.
- Its local copy is left in place, as turning sync off leaves it (§7.4).
- Turning sync on again is refused until the purge is done.

### 7.1 The account's lifecycle: the account object decides, D1 follows (CORR-02C-1)

Turning sync on, and both kinds of deletion, are each decided in one transaction in the account object. D1's `sync_accounts` row is an index, written afterwards and only as the object's answer says. So a D1 read or write held for any length of time can never decide anything. (Before this, D1 chose the generation, and each new interleaving of a held D1 call needed its own patch: CORR-00F/A9B/DE7/A62/3ED/02C.)

**What the account object holds:** `generation`, the registration it holds now; `state`; and `retired`, the highest generation it has deleted. `retired` survives the purge as a tombstone, and only rises.

| Step | Account object (one transaction) | Then D1 |
|---|---|---|
| **Turn sync on** | No account (or a tombstone): `generation = retired + 1`, `state = registering`, which takes nothing (no socket, op, batch or upload). Registering or on: answers its own generation. Deleting: refused, 409 `deleting`. | The row is upserted to `(generation, active)` only if its generation is lower: the row only moves forward. Then it is read back. If the read shows this generation active, the Worker calls `confirm(generation)`. |
| **`confirm(g)`** | Registering at `g`: now `active`. Already active at `g`: unchanged. `g ≤ retired`: refused as `retired`. Any other generation, or deleting: refused. | If refused as `retired`: that generation's row, if active, is marked purged. No storage can hold it again. |
| **Delete my synced data** `(g)` | At `g`, registering or on: `deleting`, and its sockets close. Already deleting: joins. Another generation: `stale`, nothing changes. No account: `none`. | `deleting`: the row of `g`, unless it is already purged. |
| **CoCalc's purge** | First, in its own transaction, the object is marked `deleted`, for good, whether or not it has storage (CORR-B92-1). Then whatever generation is held goes, as above. No account: `none`, with `retired`. | `deleting`: as above, under CoCalc's request id. `none`: every row of a generation `≤ retired` that isn't purged yet is marked purged. |
| **The purge finishes** (alarm) | Everything is dropped. In the same transaction, the tombstone keeps `retired = max(retired, g)`, `deleted` if it was set, and one D1 record still to write. That record replaces any earlier one not yet written, so the tombstone is three rows at most, however many purges D1 missed (LIMIT-B92-1). | One D1 batch: the row of `g` is marked purged with its counts and request id, whatever its state; the row of any older generation, all retired, that isn't purged yet is marked purged, keeping the request id its deletion wrote. For CoCalc's purge, the same batch completes every receipt of that account still `deleting` (below). A `none` answer to CoCalc's purge completes its receipt at once. If D1 fails, or isn't bound at all (LIMIT-BF3-1), the record waits a capped exponential backoff with jitter (1 to 10 minutes, ×0.5-1), and the alarm is armed for that. Each alarm makes one D1 call at most (LIMIT-B92-2). |

**Why this is enough.** Every D1 write names one generation, or the generations up to `retired`, and the object has already decided that generation's fate:
- a row is marked purged only for a generation the object has retired for good;
- a row moves to a new generation only after the object has made that generation. While the object holds `g` (registering, on, or deleting), it makes no other generation;
- so while the account takes writes at `g`, its row is at `g` and isn't purged, and the daily job (§9) asks the object before deleting any of its keys.

**The interleavings checked**, each with a test where one can be staged (web/sync/test-sync.mjs, "the lifecycle"):
- two enables at once (both get the same generation; the second confirm is a no-op);
- an enable during a deletion (refused by the object, with no generation made in it or in D1: astra's 02C trace);
- a registration held before D1, then a deletion of it, then the registration resumes (refused as retired; the row it made is marked purged);
- a registration held before D1, CoCalc's purge, then the registration resumed during the purge (refused, `deleting`) and again after it (D1 stays purged);
- a registration of an older generation resumed after newer ones (D1's row doesn't move back; refused);
- a late `confirm` of every retired generation, after one or two cycles; and a `confirm` of a generation never made, or naming another account;
- a deletion naming an older generation, a newer one, or none (stale, stale, 400);
- a purge whose D1 record fails, then sync turned on again (the record, written later from the alarm, touches only its own row), or nothing more happening (the alarm stays armed through failed retries, and the record is written later);
- two purges' records pending at once, the second for a generation that never reached D1 (both kept, each written for its own row);
- CoCalc's purge of an account with no storage, with a stray row left active (marked purged, under CoCalc's request id);
- an enable and an upload arriving after CoCalc's purge of an account that never synced, and a late enable or confirm after CoCalc's purge of one with storage (all refused, astra's probe of CORR-B92-1);
- six cycles while D1's records fail (the tombstone stays at two rows); retries backing off with jitter up to the cap, one D1 call each, then recovering (LIMIT-B92-1/2).

Staged with D1 answers held at the Worker (test gates, after astra's staging):
- a deletion's `deleting` write held until after the purge finished (guarded: not over `purged`);
- a `none` answer's write held until a new generation is registered (bounded by `≤ retired`);
- a held registration refused as retired whose marking of its row lands after a newer generation is registered (that write names the generation and requires `active`).

By reasoning only:
- the Worker stopping between any two of its steps. Before D1: the object stays registering, and the next enable goes on from there. Between the upsert and `confirm`: a row is left active for a generation the object may have retired. Nothing is wrong with it: the daily job asks the object, which knows no keys, and the next enable or CoCalc purge moves the row on.

**CoCalc's status: the receipt, then the account object** (CORR-BF3-1, CORR-1C2-1, CORR-5D0-1).
- Each CoCalc purge request gets its own row in `sync_admin_requests`, keyed by its request id.
- **The request id is bound to its account before any account object is asked** (CORR-E9C-1, LIMIT-5DC-1).
  - The binding is the purge's own record, sharing's `purges` row: made at most once for the id (`ON CONFLICT DO NOTHING`), and checked against the account. Sharing's part of the same request makes that row anyway, and a pending one is finished by sharing's scheduled job whatever becomes of the request.
  - So of two requests naming one new id for two accounts at once, exactly one binds it. The other gets 409, and its account object is never touched.
  - Sync adds no row of its own to bind, so a Worker that stops at any point leaves no sync row behind.
- **The receipt is written once the account object has answered,** and only for an account that held sync state. If the object can't be reached, nothing is recorded, and the whole purge answers 503 for CoCalc to send again.
- A retried id keeps its receipt (`INSERT OR IGNORE`) and touches no other. A receipt is completed when its account's purge record reaches D1.
- The account's D1 row is never what the status call reads, because a later request would change it.
- **The status call**, `GET /api/admin/sync-purge/<request_id>/<account_id>` (signed; the path carries the account because the signature covers the path):
  - a receipt that says `purged` answers with its counts;
  - otherwise the account object answers, the authority: `deleting`; `purged`; or `never_synced`, which means nothing to delete, so done;
  - **404 `not_requested`** only means sync's part never started: no receipt, and no CoCalc purge has reached the account object. CoCalc sends the purge again. **404 never means done;**
  - a request id asked about under another account gets 409.
- So the answer is certain after a receipt is evicted, after a completion that ran before the receipt was written, and for an account that never synced. The cocalc.ai adapter polls until `purged` or `never_synced`, and resends the purge on 404. The daily job prunes receipts 30 days after they finished (90 if they never did). CoCalc polls well within that.
- **Every purge is admitted.** Sharing's deletion never waits on sync's bookkeeping. The one refusal is a request id that already belongs to another account's purge: 409, before any account object is asked or any receipt changed. An id names one account for good (CORR-E0D-1).
- **The receipts are bounded by total** (LIMIT-233-1):
  - an account keeps at most 8. A new id evicts the account's oldest, by insertion order, in the same D1 transaction as the insert;
  - an account that never synced (the object answers `none`, nothing retired) gets no receipt. Its status, from the object, is `never_synced`. Neither does a purge whose object can't be reached;
  - CoCalc's purge fences an account for good. So the table never holds more than $8A$ receipts, where $A$ is the number of accounts that ever had sync state, whatever the rate of requests, and whatever point a Worker stops at;
  - 30 days after finishing, a receipt is pruned.
- **The prune keeps up:** each kind (finished, never finished) uses its own partial index, a page of 1,000 at a time, until none is left or 10 pages are done. That is 10,000 a run for each kind, so any backlog, at most $8A$, drains in $\lceil 8A / 10{,}000 \rceil$ runs. The prune makes at most 20 calls, inside the run's 400-call budget.

**An account CoCalc deleted stays deleted** (CORR-B92-1). Deleting a session doesn't stop a request that already read it: an enable or an upload past its session check can arrive at the account object after the purge. So CoCalc's purge marks the object `deleted` first, in a transaction of its own, even when it holds nothing, and the tombstone keeps the mark. From then on `enable` and `confirm` are refused, and nothing else can make storage. CoCalc never reuses an account id, so the mark is permanent and costs one row.

## 8. Limits, sizes and rates

For daybreak2's review. Each is enforced by the server, and each has a test. The numbers are first values: they are counted in tests, and changed where a test shows they are wrong.

| What | Limit | Over it |
|---|---|---|
| A message on a socket | 2 MiB, in UTF-8 bytes. A batch's largest body, 1 MiB, is 1.33 MiB as base64, and its 2,000 envelopes add up to about 0.4 MiB, so the first draft's 1 MiB + 64 KiB couldn't carry a full batch (LIMIT-321-3). The batch limits aren't all reachable at once: 2 MiB carries a 1 MiB body with 2,000 small envelopes, not with 2,000 envelopes each at their own maxima (8 parents and 8 blobs). | close 1009 |
| A batch | 1 MiB of body, 2,000 patches; 8 parents per patch | `limit` |
| One patch inline | 256 KiB (larger: a blob, §5.3) | `limit` |
| Ops in one message | 500; a path 1,024 bytes, a name 255 | `limit` |
| The index | 100,000 entries, 10,000 per folder (as the client's `LIMITS`) | `limit` |
| Documents per account | 100,000 | `limit` |
| Requests unanswered per socket | 8 | `busy` |
| Before authentication (§2) | 60 requests a minute per IP on `/api/sync/` and `/api/agent/` | 429, at the Worker |
| Account sockets | 20 per account (the oldest is closed) | close 4408 |
| Document sockets | 50 per document; 64 per account; 16 per session (§2) | `busy` |
| Tickets unredeemed | 32 per session | `busy` |
| `hello.docs` | 1,000 | `limit` |
| `index` replay | 1,000 ops and 1 MiB a message, then `pull_index` | `more` |
| `pull` | `limit` default 100, at most 500 batches and 4 MiB a message; one R2 segment a request | `more` |
| `blobs/check`, `outputs.set` | 1,000 and 500 items | `limit` |
| Batches per account | 20 a second, sustained 4 a second | `rate`, with `retry_after` |
| Ops per account | 2,000 a minute, each op counted, resent or new (LIMIT-321-2) | `rate`, the whole message |
| Blob uploads | 4 at once per account; `max_file_bytes` each | 429, 413 |
| Signed URLs | 600 a minute per account; each debits the blob's size from `sync.read_bytes_per_day` (§5.4) | 429, `rate` |
| Signed URL fetches | 600 a minute per IP at the files Worker | 429 |
| Snapshots kept | 3 per document | the oldest goes |
| Live batches before compaction | 200 beyond the latest snapshot | compacted |

- **Every limit is checked before any write.** A refusal changes nothing.
- **A client over a rate** waits for `retry_after`. Its changes stay on the device, and nothing is lost.

## 9. D1, the scheduled job, and the purge

- **`sync_accounts(account_hash PRIMARY KEY, prefix, state, created, generation, request_id, kind, finished, docs, bytes)`:**
  - it is written when sync is turned on, after the account object has made the generation, and before the object takes any write (§7.1);
  - `sync_admin_requests(request_id PRIMARY KEY, account_hash, state, created, finished, docs, bytes)`: one receipt per CoCalc purge request, which its status call reads (§7.1);
  - it is how the daily job finds an account's objects. It follows the account object, and never decides anything: CoCalc's purge goes to the account object whatever the row says, since an account still registering has no row yet;
  - the hash alone names the object, so the row needs no account id.
- **The purge** (sharing's `purgeAccount`): if the account has a `sync_accounts` row, the purge record also waits for the account object's purge. The purge's `files` step then covers both prefixes.
- **The off-site copy** (planned): William's office rclone mirror, which snapshots R2 and drops snapshots after about a month, is to cover the sync prefix too, as sharing's "Backups" says. It reads with a read-only R2 token from William's side. So a deletion leaves the off-site copy within about 31 days.
- **The daily job** (`syncScheduled`, beside sharing's `scheduled`):
  - it lists `s/` a page at a time, resuming where the last run stopped, as sharing's inventory does for `a/`;
  - for each object older than two days, it finds the account by the key's prefix in `sync_accounts`:
    - a purged or unknown account: the object is deleted;
    - a live one: its account object is asked which keys it knows (holdings, reservations, the outbox), and the rest are deleted;
  - this catches an R2 write whose transaction failed, and a put that commits late (CORR-5E2-2): R2 gives no bound on when a put that has sent its last byte commits, so the upload's cut-off (§5.4) bounds only the transfer, and this job stays responsible for every key, whenever its commit lands, even after the account was deleted or turned on again;
  - its bounds (LIMIT-268-1, LIMIT-SYNC-CRON-1):
    - at most 400 calls a run, every one counted: up to 20 for pruning purge receipts, then a page is begun only if its worst case (105 calls: cursor read, list, account lookup, 100 account calls, delete, cursor write) still fits;
    - a whole-run deadline of 10 minutes, against Cloudflare's 15 for a cron: no call, D1, R2 or an account object's, starts after it, and none is waited for beyond it. The run then stops where it is. Every stop is safe: a page whose account calls didn't all answer deletes nothing, and a page's cursor moves only once the page is done, so the next run repeats it.

## 10. Encryption

**(a), as decided (§7.4):** R2 and Durable Object storage are encrypted at rest by Cloudflare.

**What keeps (b), end-to-end, possible later:**
- **Opaque now:**
  - patch payloads, snapshots, outputs and blob bytes are bytes to the server. What it does read is the graph: each patch's `cseq`, id, parents, size and blob references (§4.1), which hold no content;
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
- **On dev, only allowlisted accounts may sync,** because dev.sagebrush.space is public and anyone can sign in there (@sagebrush, Oct 19).
  - The list is config, not code: `SYNC_ACCOUNTS`, a text binding of comma-separated account ids. Unset means nobody.
  - Every sync and agent route checks it after authenticating, with 403 "sync isn't enabled for this account".
  - So does every object, on each request. A test account removed from the list is refused at once, its sockets included, at their next message.
- **Turning it on in production** is a change to `web/site/cloudflare.config.ts`, and only William makes it (§7.4: no production storage of private user data until he says so).
- **Nothing public-facing changes:** no new domain, no DNS record. Signed blob URLs use a new path, `/p/`, on the existing user-content Worker, which is dev-only too until William says otherwise.

## 12. Tests

The tests run in Miniflare, as `web/share/test-share.mjs` does, with Durable Objects, D1, R2 and a fake CoCalc.

**Tests of the server:**
- **Isolation:**
  - one account can't read, write or learn of another's documents, blobs or index;
  - a document object refuses an account not on its list;
  - a forged owner in a URL reaches nothing.
- **Idempotence and membership (§4.2):**
  - an ops message and a batch, each sent twice, and again after a lost acknowledgement, apply once;
  - astra's trace: 300_C accepted; a patch whose parent is 200_C, never sent, is refused with `order`; then 200_C itself is refused as a gap, never acknowledged as a duplicate;
  - a `cseq` gap, decreasing ids, a reused `cseq` with another id, and another writer naming a client are each refused, and change nothing;
  - a mixed resend stores only the new patches, sliced from the body, and the old keep their `seq` and author;
  - an `Env` whose sizes don't add up to the body is refused; a receiver refuses a payload holding `time` or `parents`;
  - two devices sending to one document at once, through the account socket and a document socket, are ordered once;
  - a refused op gets the same refusal when resent, and an op after a `dseq` gap is refused with `order`.
- **Pins (§4.3):** a large patch's blob survives the one-day sweep, compaction and export; it is released by the epoch and by deleting the document; a forward delayed past `pin_expires` is refused; a lost answer settles the pin.
- **Compare-and-swap (§4.4):** a competing append between an agent's read and its write gives `conflict`; the write's resend after a lost acknowledgement gives its original `seq`.
- **Admission and fence (§4.5):** a revoke, a scope narrowed, and a rename out of scope while a grant's write is delayed: the write either committed before the fence (and is logged so), or is refused, never committed after the change completes; an admission past `expires` is refused.
- **The epoch (§4.6):**
  - clear, disconnect at once, and open from a fresh device: the document's value is the root;
  - the old history can't be pulled or sent back;
  - a stale `expect_head` is refused;
  - astra's disjoint edits: shared `{x0, y0}`; A edits `x1` and clears; B, offline, edited only `y1`; B's rebase gives `{x1, y1}`. With a clash on one record, B's value becomes a conflict copy, and the root is unchanged.
- **Pins across epochs (§4.3):** a grant's client pins `H` at `cseq` 1, the history is cleared, and the same client pins `H` at `cseq` 1 in the new epoch. The old pin's release, delayed until after that, leaves the new pin and the holding in place.
- **Sessions:**
  - sign-out, forget-device and the purge close the sockets they should;
  - an expired session's socket can't write;
  - a revoke whose call failed is caught by the 10-minute check;
  - a ticket can't be used for another document, account or session, after it expires, twice, or after its session is revoked (astra's replay trace);
  - a collaborator removed, or downgraded to viewer, can't send another batch, and their sockets close at once;
  - astra's race: an upgrade paused after `redeem`, the revoke completed, and then the attach resumed: the attach is refused. A fence that lands after an attach closes the socket;
  - socket leases: a lost close report frees its slot within 15 minutes. The counts are the live leases after an object is evicted.
- **Before authentication:** a fresh, made-up account hash on every request, and tokens with a bad tag, create no object and no row, and are cut off by the IP limit.
- **Reading:** the debit happens at issue; a grant's URL works once and a replay is refused; parallel and overlapping range requests on a grant's URL get at most one success; a device's URL works for its 5 minutes.
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
  - the `cseq` check, the resend id check, and the parent check;
  - the pin before the forward, and `pin_expires`;
  - `expect_head`;
  - the fence;
  - the root in the epoch's transaction;
  - the ticket's single use;
  - the tag check before any object;
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
- Should sync's storage count separately from sharing's, or share one number? The code reads `sync.storage_bytes` (separate), so either answer is a change to CoCalc's limits, not to this server.
- *Answered* (@sagebrush, Oct 19): try it on dev.sagebrush.space, restricted to `SYNC_ACCOUNTS` (§11).

**Agreed with @sagebrush-board (Oct 19):**
- @sagebrush-board owns `sync-reduce.ts`, its JSON test vectors (loaded by both sides) and `web/workspace/sync-client.ts`, with fixtures this server replays in Miniflare.
- `ref`, `fid` and `base` are added to `Op`.
- Journal patches (`meta.journal`) are ordinary patches.
- A board's snapshot is its JSON; a notebook's is its document without outputs.
- The device's versions stay local (§3).

**Still open with @sagebrush-board:**
- the `Env` fields (§5.2);
- `meta.blob` for large patches;
- who sends snapshots, and when;
- the 64 KiB limit on a keepalive request when a page is hidden.
