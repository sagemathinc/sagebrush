# Agent-scale sync: membership limits, batched files and real-world verification

*Status: design. Commissioned by William, Nov 8 2026 (~9:15 PM PST), after the first fs-sync rate estimate showed that 5,000 files would take at least four hours. This is the one design change for the agent endpoint, fs-sync, its server index and git projects. Reviews: ENGINE, SEC, LIMITS, TESTS and COPY. No implementation starts until all five clear it.*

William's requirements are the invariants:

- an agent-facing product limit is a value of the person's membership, not a number compiled into Sagebrush;
- the refusal says which membership raises it;
- many small files travel in batches, so a paid membership first-syncs 10,000 files / 500 MB in minutes;
- 10,000 files, 100,000 files and the Sagebrush repository itself are scale tests, with backend load measured as well as elapsed time.

The numeric quotas themselves are CoCalc business configuration, not repository policy. This note fixes the performance targets and the evidence required before William chooses or raises those values.

## 1. One membership record

CoCalc's limits answer (design/sync-server.md §6) has a required, versioned `sync.agent` object:

```
sync.agent = {
  version, tier,
  requests_per_minute, requests_per_hour,
  ops_per_minute, blob_concurrency, signed_urls_per_minute,
  read_bytes_per_day, write_bytes_per_day, max_file_bytes,
  list_page_entries, list_call_entries, list_examined_rows,
  batch_files, batch_bytes, batch_concurrency,
  workspace_entries, folder_entries,
  index_entries, index_tombstones,
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

Every numeric field is a non-negative safe integer; `version` is a supported positive integer and `tier` is the name the person sees. `upgrade[field]` is the least currently offered membership whose value is larger. `null` means no advertised membership raises it. CoCalc computes this map from the same tier table as the values, so Sagebrush never guesses a product name or price.

**There is no old-number fallback.** An account object keeps its last good complete record through an outage, however old. If it has never received one, authenticated agent operations and git-project imports answer 503 `limits_unavailable`; person sync continues under its already-held storage claim. DEV and tests inject an explicit development record. A malformed or unsupported record is rejected whole and never partly installed. Zero means zero. A signed plan notice replaces the record at once, with the existing generation/revision fencing.

A grant may carry person-chosen reductions, for example a smaller daily byte allowance. Its effective value is the lesser of that reduction and the account's current membership value. It can never raise a membership value.

### 1.1 Product limits versus safety bounds

The fields above are **product limits**. They are the only numeric capacities an authenticated agent, fs-sync run or git-project import may hit in ordinary use. A source census fails when implementation adds such a cap without a field and an at-limit / one-past test.

These are not paid limits and stay separately named:

- path syntax and representation: 255-byte name, 1,024-byte path, workspace depth 32, protocol integer/string validity;
- Cloudflare/Worker request-body and runtime ceilings;
- pre-authentication IP, pairing-code and wrong-secret abuse controls, since no membership has been authenticated yet;
- Stop, memory reservation, bounded transaction/alarm slices and other host fairness controls;
- fs-sync's checks for the person's local free disk, private state files, no-follow paths and delete confirmation.

A safety refusal never suggests an upgrade. Local storage messages say what disk resource is missing. The per-alarm index meter is a work slice, not an index failure: more slices are scheduled to meet the membership's target without one account monopolizing a Durable Object turn.

### 1.2 Refusals and downgrades

An authenticated product refusal includes:

```
{error: "limit" | "rate", limit, used, max, tier,
 upgrade_tier, upgrade_max, retry_after?}
```

`upgrade_tier` and `upgrade_max` are absent only when `upgrade[limit]` is null. COPY supplies one sentence used by the site and CLI; it names the current allowance and, when present, the membership and allowance that raise it. A rate refusal also gives the real refill time.

A downgrade takes effect for new work, but does not make existing data unreadable or fail an already complete index. Population limits govern growth. A rebuild indexes all existing rows; while existing use is over the new value, reads continue and creates are refused. Normal person sync is never rolled back or refused because the agent index failed.

## 2. Batched small files

The agent schema adds `files.batch`, one idempotent call for many small-file operations. fs-sync uses it in both directions.

```
files.batch({batch_id, items: [
  {id, op: "write", path, fid?, base, sha256, size, part},
  {id, op: "read",  path, fid, revision},
  {id, op: "mkdir" | "remove" | "stat", path, ...preconditions}
]})
```

- `batch_id` is random and stable across a retry; item ids are unique in it. A completed retry returns the recorded per-item results and performs no operation twice.
- The request has at most `batch_files` items and `batch_bytes` inline bytes, and an account has at most `batch_concurrency` admitted batches. These membership values are also bounded by the named Worker body ceiling.
- Upload bytes are multipart and content-addressed. Existing large/chunked upload remains the path for one file that does not fit inline. Downloads of small files are a bounded multipart response; a large file retains its signed/chunked route.
- Before a body is retained, admission reserves the batch's total bytes and possible entry growth. Missing immutable blobs are staged, then one serialized account-object call checks every grant/scope/generation/base/fid precondition and publishes the successful ops in request order. An item is fully committed or not committed; another item's conflict does not disguise or partly apply it.
- One batch consumes one request token. Every byte, item, index row, Durable Object storage operation, D1 operation and R2 operation is still charged and reported. Batching is not a way around a daily, file, folder, entry or index allowance.
- A disconnect or Stop leaves staged, unpublished blobs collectible by the existing outbox. No partial index is visible. A retry never repeats a published op.

Capability discovery returns the effective values. fs-sync packs up to them, uses fewer items when the byte bound comes first, and may adapt downward after a structural 413. The 10,000-file fixture should need tens of agent HTTP calls, not 10,000.

## 3. Index and folder cost

The server index reads `workspace_entries`, `folder_entries`, `index_entries`, `index_tombstones`, page sizes and examined-row limits from the account's installed record. `index_entries` cannot be below `workspace_entries`. Live entries and tombstones are separate populations.

The current prototype loads every child of a touched folder, so an edit in an $n$-child folder costs about $n$ Durable Object row reads. Before any membership advertises `folder_entries > 10000`, child/name tests use keyed storage lookups; a higher paid allowance must not turn an ordinary edit into a linear scan.

Backfill remains sliced by the operational visit/operation/byte meter, with discarded retry work charged within the invocation. A budget stop never advances the cursor. Readiness time, including all alarm steps, is part of the tier's wall-time target below, not hidden after the client says it finished.

## 4. Performance targets

The membership service owns tier names and final values. Verification uses these three capability profiles; an offered tier maps to one of them.

| profile | 10,000 files / 500 MB, cold first sync | 100,000-file fixture | pinned Sagebrush repository |
|---|---:|---:|---:|
| basic/free floor | at most 15 minutes when its storage and daily bytes admit the fixture; otherwise the plan names the first tier that does | measured, no promise | measured, no promise |
| standard paid | at most 5 minutes | at most 30 minutes | at most 10 minutes through fs-sync; at most 10 minutes as a git project |
| high-throughput paid | at most 2 minutes | at most 10 minutes | at most 5 minutes through either path |

For fs-sync, `.git/` stays ignored: that fixture is the pinned checked-out tree plus its ordinary project files. The git-project fixture exercises the pinned repository's full deep-history import path and verifies its source commit. The evidence records both transferred and deduplicated bytes, so the two paths are not presented as equivalent work.

No request/hour bucket may make its target mathematically impossible. A paid profile's daily byte value admits the whole target plus retry headroom. Initial values come from the measured batch size and rate with at least 2x concurrency headroom; they then live only in CoCalc's tier table.

At minimum, standard paid admits 100,000 live workspace/index entries and a 10,000-entry folder. High-throughput exceeds both. A tier's tombstone value is tested independently. These are acceptance minima, not constants to paste into code.

## 5. The nightly sbpool scale gate

These tests are too large for PR CI. A small deterministic contract test stays in PR CI; the real fixtures run on the new sbpool nightly and before a tier value is raised.

### 5.1 Fixtures

1. **10,000 files / 500 MB:** a recorded realistic size distribution, nested and hot folders, duplicates, empty files and incompressible files.
2. **100,000 files:** broad and deep trees, plus variants exactly at and one past every entry, folder, index and tombstone membership value.
3. **Sagebrush:** a pinned commit and source checksum. fs-sync runs its checked-out tree; git projects imports the pinned repository path and validates the commit/tree. The recorded source is at least 500 MB for the deep-history case.

For each applicable profile: cold upload/import, cold download, warm no-op, interrupted resume, changed subset, deletes/replacements, deduplication and concurrent accounts. A 100,000-file replace/delete run also checks fs-sync's local holding/state path; local entry capacity scales with the discovered file target rather than imposing a smaller product ceiling.

### 5.2 Measurements

Every result pins source commit, server commit, client version, membership record and fixture checksum, and reports median and p95 across repeated runs (never fastest-only):

- client scan/hash/plan/apply and end-to-end wall time, files/s and bytes/s;
- Worker requests, CPU time, wall time, peak memory, retries, 429 and 5xx;
- Durable Object calls, storage rows read/written/deleted, statements, transaction time, alarm steps and maximum/sum of the index visit meter;
- D1 queries, rows read and rows written;
- R2 Class A/Class B operations, bytes and deduplication;
- projected backend cost and load at the tier's supported concurrency.

The gate requires the wall-time target, all correctness/resume invariants, and an explicit load envelope with 2x concurrency headroom. D1 membership/budget work is O(batches), never O(files); account publication is one bounded call per batch; R2 work is at most one PUT per missing content blob and one GET per transferred blob, without multiplicative retries. The at-limit case passes and the one-past case refuses before work with the exact upgrade-bearing answer.

A proposed quota increase is not enabled until this gate passes at that value. Results are retained as versioned artifacts, so time, load and cost regressions are reviewable.

## 6. Delivery and tests

The implementation may be sliced, but the schema, batch protocol, index behavior and scale gate are one reviewed design:

1. membership parsing/cache/notice and the limit census;
2. tier-valued index populations and keyed child lookup;
3. server `files.batch` and idempotency;
4. fs-sync discovery, batch packing and local-bound scaling;
5. sbpool fixtures and load reports; then CoCalc tier values chosen from the evidence.

PR CI lowers every field and pins: exact limit succeeds, one past refuses before work, upgrade metadata is correct, downgrade preserves reads, an absent/malformed record fails closed, a batch retry is idempotent, a conflict cannot partly publish, and a new authenticated numeric cap fails the census until registered. Nightly owns performance, not correctness.
