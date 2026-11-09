# Agent-scale sync: membership limits, batched files and real-world verification

*Status: design. Commissioned by William, Nov 8 2026 (~9:15 PM PST). This is the one design change for the agent endpoint, fs-sync, its server index and git projects. Reviews: ENGINE, SEC, LIMITS/PERF, TESTS, COPY and DESIGN. Nothing here is implemented yet.*

## In plain words

- Agent sync limits come from the person's membership, not numbers built into Sagebrush.
- A membership refusal says the allowance and, when one exists, which membership allows more.
- Small files travel in batches, so a 10,000-file first sync takes minutes rather than hours.
- Tests exercise 10,000 files, 100,000 files and the pinned Sagebrush tree, including crashes and concurrent accounts.
- Nightly runs check correctness and counted server load; named DEV runs measure real elapsed time before a tier is raised.

The numeric quotas themselves are CoCalc business configuration. This note fixes the protocol, performance targets and evidence required before William chooses or raises them.

## 1. One membership record

CoCalc's limits answer (design/sync-server.md §6) has a required, versioned `sync.agent` object:

```
sync.agent = {
  version, tier,
  requests_per_minute, requests_per_hour,
  ops_per_minute, blob_concurrency, signed_urls_per_minute,
  read_bytes_per_day, write_bytes_per_day, max_file_bytes,
  batch_files, batch_bytes, batch_concurrency,
  workspace_entries, folder_entries,
  document_bytes, document_batches,
  runs_concurrent, runs_per_hour, sockets, confirmations,
  live_grants, scopes_per_grant, grant_days_max,
  access_log_rows, access_log_days,
  inbox_item_bytes, inbox_waiting_items, inbox_items_per_sender_per_day,
  git_project_entries, git_project_tree_bytes, git_project_archive_bytes,
  git_project_concurrency,
  upgrade: { <field>: {tier, value} | null }
}
```

Every numeric field is a non-negative integer no larger than $2^{53}-1$. `version` is a supported positive integer and `tier` is the name the person sees. `upgrade[field]` is the least currently offered membership whose value is larger; `null` means none. CoCalc derives both from one tier table, so Sagebrush never guesses a product name or price.

There is no compiled product fallback. An account keeps its last good complete record through an outage. Before this feature is enabled, CoCalc installs complete records for existing accounts. If an account has never received one, authenticated agent operations, git-project imports, and any person file operation that could grow `workspace_entries` or `folder_entries` answer 503 `limits_unavailable`; existing data remains readable, document-only edits and non-growing file operations continue, and no incomplete record is partly installed. DEV and tests inject an explicit record. A signed plan notice replaces it with generation/revision fencing.

A grant may reduce a value but cannot raise it. Population limits govern growth at workspace-operation admission, not index construction. A downgrade never makes existing data unreadable.

### 1.1 Product limits and host capabilities

The object above contains product limits. A source census fails when implementation adds an authenticated product cap without a field and at-limit/one-past pins. Its negative control plants an unregistered cap and proves the checker fails.

Separately named host and protocol capabilities include path representation, Worker request-body/runtime ceilings, transport chunk size, response page size, examined rows per turn, operations per internal message, Stop/memory/transaction/alarm slices, and pre-authentication abuse controls. Discovery advertises the effective structural ceilings needed by a client. It clamps work or makes it resumable; it does not become a paid allowance. A safety refusal never names a tier or suggests a membership.

The effective one-file value is `min(max_file_bytes, upload_route_bytes)`. If membership binds, the membership refusal applies. If the route binds, it is a safety refusal:

```
  · lecture.mp4   624 MiB, more than the 500 MiB one upload can carry
```

Files larger than an operational fairness slice still stream through bounded buffers and resumable, interruptible per-item progress. The implementation records maximum turn work and peak memory; it neither monopolizes a turn nor restarts the file from zero forever.

### 1.2 Refusals, downgrades and audit retention

An authenticated product refusal includes:

```
{error: "limit" | "rate", limit, used, max, tier,
 upgrade_tier, upgrade_max, retry_after?}
```

`upgrade_tier` and `upgrade_max` are absent exactly when `upgrade[limit]` is null. A checker fails a refusal that omits them when the map supplies them. The shared wording is:

- `<subject> has <used> <noun>, more than the <max> your <tier> membership allows.`
- For a rate/daily limit: `<subject> has used the <max> <noun> your <tier> membership allows <per period>. It can continue in <retry_after>.`
- When present: `A <upgrade_tier> membership allows <upgrade_max>.`
- At an already-full population: `This workspace has 100,000 files and folders, the most your Basic membership allows. A Standard membership allows 1,000,000.`
- Per-file: `  · lecture.mp4   624 MiB, more than the 512 MiB for one file your Basic membership allows; a Standard membership allows 2 GiB`

There is no price, the word “upgrade” is not shown, and safety refusals never append the membership sentence.

Access-log retention has a product-owned minimum age that every account receives: `AUDIT_MIN_DAYS = pending William; proposed 90`. Membership may extend but never shorten it, including zero or downgrade. `access_log_days` is the promised age and `access_log_rows` is additional retained capacity: cleanup may delete a row only after the age promise has passed, then trims oldest rows above the count in bounded slices. Thus a busy account cannot silently turn a row count into a shorter age promise. Append and cleanup remain bounded and pinned at zero and downgrade.

## 2. `files.batch`

`files.batch` carries many small operations in one request:

```
files.batch({admission_id, batch_id, request_digest, items: [
  {id, op: "write", path, fid?, base, sha256, size, part},
  {id, op: "read", path, fid, revision},
  {id, op: "mkdir" | "remove" | "stat", path, ...preconditions}
]})
```

An authenticated admission binds its expiry window, account generation, grant identity and canonical request digest. `(admission_id,batch_id)` with different content refuses. The durable state machine is `admitted -> staging -> publishing -> done`; item identities are permanent within it and item result plus workspace operation are committed atomically. Dependencies such as mkdir-before-child are explicit; a failed dependency fails only its dependents.

The server rechecks current authentication, grant scope and account generation before returning either new or recorded results. A lost answer may be retried with the same identity at most twice in one fs-sync run. The server-enforced window is minutes and covers that retry interval. After expiry it answers `replan_required`; eviction cannot reinterpret the old identity as a fresh batch. A new run never reuses ids and replans from live state.

Publication may use internal chunks no larger than the server's operations-per-message capability, but all chunks share the durable identity. An item's operation and result are exactly once; completed retries return recorded results. Staged blobs, byte/entry reservations and concurrency are released exactly on Stop, abort, expiry and crash recovery. Recorded results and receipts have bounded retention; read results bind the same `epoch.head_seq` revision as list/stat and are re-authorized before transfer.

Multipart upload and download stream between file handles using a named client/server buffered-byte safety ceiling. Files are rehashed and fail if they change. Neither side buffers a whole large file or whole response. Per-turn work is bounded and resumable.

### 2.1 Product-meter ledger

- One newly admitted successful `batch_id` reserves one token in each request bucket. Discovery itself also costs one request.
- Every item reserves one `ops_per_minute` unit before work unless its schema names a different fixed unit. The whole batch is reserved first.
- Logical read/write bytes, possible entry/folder growth, batch concurrency and blob/signed-URL units are checked against their named membership fields before corresponding work.
- An idempotent retry does not debit product meters twice. An abandoned pre-publication batch releases reservations.
- DO, D1 and R2 operations are telemetry, not product charges unless a future membership field explicitly meters one. Physical retry work remains telemetry.
- At-limit succeeds and one-past refuses before body retention or backend work. The plan and Cost table show request, operation and byte reservations separately and choose the fitting prefix against all meters.

### 2.2 Crash contract

Named deterministic test seams cover: after staging/before publication (nothing visible; blobs collectible), after publication/before answer (retry returns the recorded rows and applies nothing twice), each internal publication chunk, and `after_batch_answer(batch)`. One conflicting item is wholly absent while independent items publish. No pin relies on a timeout.

## 3. Index population, visibility and large subtree operations

`workspace_entries` and `folder_entries` are enforced where a workspace operation could grow population. The index has a separately named non-membership safety ceiling high enough for the largest supported population plus existing downgraded accounts; reaching it is a safety failure, not a tier refusal. List page, call and examined-row values are server capabilities clamped to reviewed host ceilings, not membership fields.

Tombstones are compacted at a durable live-entry checkpoint. Once a ready index publishes the checkpoint at a cursor, readers older than it take a full index snapshot/resync; bounded cleanup may then delete superseded tombstones. Existing rows and rebuilds never fail because a person downgraded.

Keyed child lookup makes ordinary edits bounded, but rename and Trash still rewrite descendants in the shared reducer. Those operations use a durable resumable subtree state: accepted person operations remain accepted; preflight and apply progress are bounded; every index read answers 503 `index_building` with `retry_after` until completion; crashes resume; no partial cursor or index is published. BudgetStop does not advance the cursor. Final cursor/readiness publication and bounded cleanup are atomic, and the result exactly matches the shared reducer. Rename and Trash fixtures cover at least 90% of every profile, boundary/+1 slices, crashes in each phase, and rebuild through the same operation.

## 4. Atomic git-project visibility

A hidden import generation emits no ordinary visible operations. Every reader—list, stat, direct fid/read, `git_base`, device polling and watch—checks the visible generation pointer. Final publication first performs all per-entry conversion in bounded slices, then rechecks account/limits revisions, destination, counts, hashes, blobs and reservations. One transaction flips the pointer, appends one versioned `attach_generation` event at the next gap-free operation sequence, and marks the import done.

Compatible clients materialize the referenced manifest, paging under that event identity, before advancing their cursor. Incompatible clients receive `upgrade_required` and take a full snapshot; no client can skip hidden sequence numbers or observe a partial generation. Cancel/reset first invalidates the generation, releases its aggregate reservations, and cleans staging in bounded slices. Lost-answer, revoke/reset/replay, concurrent operation/import, competing import and crash-at-every-slice pins prove all-or-nothing visibility.

Archive import is the pinned commit's current tree, not a deep-history transfer. A source repository may have 500 MB of history, but evidence reports the actual archive/tree bytes transferred and deduplicated.

## 5. Performance targets

| profile | 10,000 files / 500 MB, cold first sync | 100,000-file fixture | pinned Sagebrush tree |
|---|---:|---:|---:|
| basic/free floor | at most 15 minutes when storage and daily bytes admit it | measured, no promise | measured, no promise |
| standard paid | at most 5 minutes | at most 30 minutes | at most 10 minutes through either path |
| high-throughput paid | at most 2 minutes | at most 10 minutes | at most 5 minutes through either path |

For fs-sync, `.git/` is ignored. Git projects import the pinned current tree. No request bucket may make its target mathematically impossible. Standard paid admits at least 100,000 live workspace entries and a 10,000-entry folder; high-throughput exceeds both. These are acceptance targets for CoCalc's tier table, not constants for source code.

## 6. Evidence gates

### 6.1 PR CI

PR CI owns every correctness rule at lowered values. In addition to at-limit/one-past, downgrade, malformed record, crash and visibility pins, it runs identical syncs at 200 and 2,000 files with a lowered batch size. Exact equations assert that D1 queries/rows and DO publication calls are functions of batch count, while R2 PUTs equal missing blobs, at both sizes. This catches per-file control-plane work without timing a shared runner.

### 6.2 Nightly sbpool counts and correctness

Committed fixtures are generated from fixed seeds and include their size distribution, generator and checksums: 10,000 files/500 MB; 100,000 broad/deep trees with real at-limit/one-past cases; and a pinned Sagebrush tree. They exercise cold upload/import/download, warm no-op, changed subsets, deletes/replacements, deduplication, interrupted resume and concurrent accounts. The 100,000-file replacement also proves the local holding path, and every profile renames and Trashes a top-level subtree containing at least 90% of its entries. Checksum mismatch fails before work. Each fixture/profile runs at least five times; records include median and p95. Exit 75 preemption is discarded and requeued, never counted or reported as failure.

sbpool gates correctness at real values and deterministic counts only: requests/retries/429/5xx; DO calls, rows/statements/transactions/alarm steps; D1 queries/rows; R2 Class A/B operations and bytes; resume, concurrent-account and crash rules. D1 and DO control-plane counts are exact functions of batches/internal chunks, R2 PUTs equal missing blobs, and R2 GETs equal transferred blobs, without multiplicative retry work. Instrumented workerd/Miniflare counters are labelled local and never presented as Cloudflare measurements. A correctness failure is a bug report with evidence and blocks the tier raise under test.

### 6.3 Named DEV reference runs

Elapsed-time targets, real Worker CPU/wall time and peak memory, and real R2 latency run on a pinned DEV Cloudflare deployment from a fixed client host whose cores, network and region are recorded, on a stated schedule and before a tier raise. They inform William's tier-raise card; they are not nightly pass/fail numbers.

For each proposed profile the card names supported per-account batch/import concurrency and concurrent-account load, plus configured capacity ceilings for Worker CPU/wall/memory, DO rows/statements/transactions/alarms, D1 queries/rows and R2 A/B operations/bytes. Counts and reference measurements/projected p95 must fit every ceiling at twice the supported concurrency. Missing capacity data is not a pass. Versioned artifacts retain commits, client, membership record, fixture, all meters, transferred/deduplicated bytes and projected backend cost.

## 7. Delivery

1. membership parsing/cache/notice, rollout and census;
2. population admission, host capabilities, resumable subtree index and compaction;
3. server `files.batch` lifecycle and meters;
4. fs-sync discovery, streaming batch packing and local scaling;
5. atomic git generations;
6. fixtures, sbpool count reports and named DEV reference reports; then CoCalc chooses tier values.

No tier is enabled or raised until its real-value correctness/count evidence and its reference capacity card are complete.
