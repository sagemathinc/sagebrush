# Agent messages (M7): the wire contract between the page, the fleet Worker and a host

*Status: cleared design; not built in this repository yet. This file is the reviewed text: r6, then its deltas r7 to r11 in order, each standing except where a later one changes it. A delta's text wins over the revisions before it. The sha256 of each reviewed revision is in the table below; the text here differs from those bytes only in heading levels and in naming reviewers by lane (SEC, TESTS) rather than by name. The schemas and verifiers are in sagebrush-agent (`schema/fleet/fleet.schema.json`, the bodies `agent-message` and `agent-reply`; `lib/fleet/core/verify.mjs`, `verifyAgentMessage` and `verifyAgentReply`). This repository's copy of the fleet core moves with its mirror pin, not with this file.*

| Revision | sha256 | What it settles |
|---|---|---|
| r6 | `a372fb354232bd17fff97a7a65aac423969b87a56846c537b0676f85ba68ca90` | the contract: records, routes, sealing both ways, the host's checks, rows |
| r7 | `e118a55b40c16155d7588afe47cea6c711a274ce37f7a8e13a73d684f51cb15b` | the limits rulings: no turn time limit, steering into a running turn, the turn_failed reasons |
| r8 | `9732a889a4cfd093236f9ea0d6bd82e064e9d03f8f5ced51cd2187b15b490e55` | one turn_failed covering every message a turn took (G1), redelivery after a crash |
| r9 | `3be5c3cc1c96c2165ef7a927852f30356df9134d3a2b29694076f14a8551be7c` | a turn's answer as a sequence of records of at most 64, persisted before the first POST |
| r10 | `bc9185630b7fe1d0c1a6aa2bc37dff88563ba1ab13cd3cb08ce056786fddd006` | answers split by thread (X1), permanent refusals leave the resend loop, the PUT rows |
| r11 | `c24c03c33519217dd8054294e631d926dde1c1bfe26abe756ddd99f56695b397` | the closed reasons answer_lost and not_granted, and aud in every body |

## Conditions carried into the service and the page (from the reviews of the schemas and of r11)

These hold in addition to the text below, and each comes with its row in the PR that builds it.

- **R1 covers `refused` records too (SEC).** r11 has the host post a `refused` record with `not_granted`, whose `in_reply_to` names a message that wasn't for its agent. A `refused` record marks that message on the page, so before storing one the service checks that its `in_reply_to` is a message delivered to THIS host: the same fleet, at or below the host's delivered high-water mark. Otherwise the record is refused `bad_covers` and nothing is stored. Without this check one host could mark another host's messages refused.
  - Row: a `refused` record naming a message delivered to another host is `bad_covers`, and nothing is stored.
- **r11's `not_granted` row (TESTS).** A `refused not_granted` for a message naming ANOTHER agent sits in that agent's thread, so the service refuses it `not_found` (r3 §4) and the host takes r10's permanent-refusal path: the record leaves the resend queue and is logged with its closed code and id. r11's first `not_granted` row expects exactly that for the other-agent case.
- **The callers' checks (SEC).** The verifiers leave three checks to their callers, each with rows in the PR that calls them: a reply's agent is one the host owns, and its `covers` and `answer` pass R1 (the service); the host's certificate is valid at the record's `chain_seq` (every caller).
- **The page signs only this type (SEC).** The page signs `sb.agent-message.v1` through the same signing barrier as every other device-signed type: the body built from typed inputs, a grant minted for those exact bytes. The message path never signs any other type. Row: the message path refuses to sign a body whose type isn't `sb.agent-message.v1`.

---

## Agent messages (M7): the wire contract between the page, the fleet Worker and a host (draft r6)

Status: draft r6. Nothing is built. r6 takes TESTS' hold on r4 (R1-R5; R1 and R5 were already met in r5): a fold replies under the last VERIFIED send's key (R2), the sealed reply persisted before its first POST (R3), the page storing the reply key before the send and the plaintext's exact encoding (R4). SEC cleared r4 with the pruning correction r5 already has. r5 took SEC's CLEAR of r3 (f4eb69cb) and TESTS' holds on r3 (U1-U4, and their notes as rows), and settles the id set's pruning at at_ms + window (the host lane's point on r4; SEC's r3 verdict states the same). r4 took SEC's clearance of r2 (cd2bfbff) with its §6 ruling and conditions M1-M3: sends sealed now, replies sealed under a per-send reply key, clear replies only for a DEV first try (not taken: @sagebrush chose sealed replies from the start). r3 took TESTS' hold on r2 (cd2bfbff): the subject's source (D1), deleting a thread (D2), and the rows T1-T14; and the host lane's three precisions on r2 (only verified ids burned, too_new, one sync per wake). r2 took the host lane's review of r1 (6075e7eb): sends are device-signed (H1), the host's own replay and order checks (H2), host-signed replies (H3), and N1-N6. It implements the first slice of the autonomous-agents design (#1626 §4 message wakes, §5 messages, §7 the thread and reply box), shaped to the fleet as built: hosts paired into a fleet chain, agents granted by the chain, units started by the supervisor.

**The first slice:** one host, one agent, woken only by a message. The person writes in the agent's thread on the Agents page; the host's supervisor polls, wakes the agent for one turn, and posts its reply into the thread.

### 1. Who does what

| Part | Where | Owner |
|---|---|---|
| The message service: threads, inboxes, cursors, receipts, limits | the fleet Worker (web/cloud/fleet), one Durable Object per fleet | remote compute |
| The page: the agent's thread, the reply box, the directory | the Agents page (web/agents) | remote compute |
| The host: poll, wake, one turn at a time, reply | sagebrush-agent host (lib/fleet/host) | host lane |
| Credentials, the chain, grants, audit | core and the host | host lane |

The service never makes an outbound connection. Hosts and pages connect to it.

### 2. Authentication and authority

**The service is never an authority over a host.** It stores and forwards. Everything the host acts on is signed by someone the chain names, and the host checks it against its own pinned chain.

**A host's requests** carry the existing `Sagebrush-Sig` header, checked by core `verifyRequest`:
- aud, the 5-minute window, the signature against the host key in `fleet_host_certs`, the host's gen, and the nonce, consumed once and kept 10 minutes;
- `agent` is filled on every request about one agent's inbox or reply (`-` only on the fleet-wide poll, §4).

**The generation (N1):**
- The agent must be in the host's **latest issued** grant, so a narrowing cuts it off at once.
- The header's `gen` must be that grant's gen, or the one before it while the host's grant-ack for the latest is outstanding (the grant-ack route, migration 0007, says which gen the host has applied).
- Otherwise the answer is `stale_generation`. The host runs its grant intake, then retries.
- The other refusals use the closed codes the relay control uses: `not_granted`, `agent_revoked`, `host_revoked`.

**The page's requests** use the person's own session (`shareSession`, as person.ts does), and the account must own the fleet. That decides only who may store and read records in the service, never what a host does.

**Sends are device-signed (H1).** Every person→agent message carries a signed envelope `sb.agent-message.v1`, a closed schema in fleet.schema.json (the core schemas lane):

```
{ fleet, host, agent, thread, id, in_reply_to, at_ms, chain_seq, body_sha256 }
```

- `body_sha256` is the SHA-256 of the `ct` bytes (§6): the service never gets a plaintext hash.
- The signer is any enrolled, non-removed device of the fleet. No native tier is needed: a message can't widen the grant.
- The page's signing code is the same as M4's pairing approval needs (fleet-device.ts doesn't sign yet): one dependency, built once, for both.
- The service checks the envelope's form (the closed schema: an extra or missing field is refused, `bad_form`), that each field matches the request and the route's fleet, host and agent, and that `body_sha256` matches the `ct` bytes it was sent (`bad_body` otherwise). So malformed sends never reach a host. The service doesn't verify the signature, and its checks aren't trusted: the host verifies everything again (§7).

**Replies are host-signed (H3).** Every agent→person record carries `sb.agent-reply.v1`, signed by the host's cert key:

```
{ fleet, host, agent, thread, id, in_reply_to, turn, kind, at_ms, chain_seq, body_sha256 }
```

- `kind` is `"reply"`, `"turn_failed"` (N2) or `"refused"` (§7). The page may post only `kind: "message"`; the host may post only the other three (`bad_kind` otherwise). A `reason` must be one of its kind's closed codes (§7), and is null for `message` and `reply`.
- The page verifies it against the chain it already pins and shows a record that doesn't verify as unverified, never as the agent's words.
- So replies are authenticated by the signature and confidential by the reply key (§6).

Pause, stop and every widening stay person-signed chain operations, never messages.

### 3. Records

**A thread** belongs to one fleet, one host and one agent: `{thread: B22, fleet, host, agent, created_ms, subject, deleted_ms}`. Its id is chosen by the page when it starts the thread. An id the service already holds for any other (fleet, host, agent) is refused (`thread_conflict`), never joined.

**The subject (D1)** is metadata the page sends with the thread's first message: at most 120 characters, NFC, no control characters. It's never derived from a body, which the service can't read. It's an opaque label the person types, knowing it's visible: the field says "Visible to the Sagebrush service" beside it (M2). The service never stores a subject taken from content. It's optional: an empty subject shows as the thread's first send time.

**The subject is unsigned and never reaches a host (U1).** It isn't in `sb.agent-message.v1`, so a hostile service could rewrite it; therefore the host's inbox records don't carry it, and nothing from it enters a turn. It's the person's label for the page alone.

**A message:**

```
{ id: B22 (chosen by the sender: the idempotency key),
  thread: B22,
  fleet, host, agent,
  from: "person" | "agent",
  seq: n,               // assigned by the service: the agent's inbox order (person -> agent), or the thread's order
  in_reply_to: B22 | null,
  priority: "low" | "normal" | "high",
  sent_ms: n,           // the service's clock at acceptance
  kind: "message" | "reply" | "turn_failed" | "refused",
  reason: string | null, // turn_failed and refused: a closed code (§7), never text from the model
  sealed: { enc, ct } | { nonce, ct }, // §6: person -> agent HPKE (enc, ct); agent -> person AEAD under the send's reply key (nonce, ct). No clear body exists in r4.
  envelope: { body, sig } // sb.agent-message.v1 (person -> agent) or sb.agent-reply.v1 (agent -> person), §2
}
```

Bodies are always sealed (§6). The service reads the metadata alone.

**Two sequences:**
- **The inbox seq:** per (fleet, agent), the order of person→agent messages. This is the host's cursor.
- **The thread seq:** per thread, the order of everything in it, both ways. This is the page's cursor.

Both are gap-free and start at 1. **Neither is trusted by the host for safety (H2):** they order presentation only, and the host's own checks are in §7. A message's `seq` in the host's view is the inbox seq; in the page's view it is the thread seq. Every record carries both, as `inbox_seq` and `thread_seq`.

### 4. Routes

#### The host's (Sagebrush-Sig, `agent` filled)

- `GET /api/fleet/v1/host/inbox?after=<inbox_seq>&wait=<s>` (one agent; with `agent=-` in the header and `after` as a map `{agent: inbox_seq}` in a POST of the same path's `/all` form, every granted agent's new messages at once, each checked against the grant: N3, reserved for after the first slice)
  - The agent's messages after the cursor, oldest first. It answers at most 64 messages or 1 MiB, whichever comes first, with `more: true` when there are more.
  - With `wait` (at most 25 s), the call holds open until something arrives or the wait ends. This is a long poll served by the Durable Object, never a Worker loop.
  - **Auth at answer time:** the host and agent are checked against the grant when the call arrives AND again when it answers. An agent revoked during a held poll gets the refusal, never the messages. A DO evicted mid-poll drops the poll; the host polls again from its cursor and misses nothing.
  - `more: true` only when at least one further record exists; never an empty page with `more: true`.
  - The host keeps its cursor durably. A message is delivered at least once. The host dedupes by `id`.
- `POST /api/fleet/v1/host/inbox/ack {upto: <inbox_seq>}`
  - Idempotent, and it never moves backwards. An `upto` at or below the cursor answers ok and changes nothing.
  - `upto` may not pass the highest inbox seq the service has delivered to this host for this agent (`ack_ahead` otherwise), so a host can't mark unseen messages "seen" or empty the unacked budget without receiving them. That delivered high-water mark is durable: written in the same storage transaction as the poll's answer, so it survives the DO's eviction (U4).
  - It marks the messages read, which is the page's receipt ("seen by the agent"). Acked messages stay in their thread. Ack moves the host's server-side cursor; it doesn't delete anything.
- `POST /api/fleet/v1/host/reply {id, thread, in_reply_to, kind, reason, body | sealed, priority, envelope}`
  - `idem` and `op` are required. The dedupe key is (fleet, agent, `id`): a resend whose canonical record is byte-identical returns the first answer; the same `id` with any other content is refused `id_conflict` and stores nothing.
  - The thread must belong to this agent on this host (`not_found` otherwise, the same answer as an unknown thread), and mustn't be deleted (`thread_deleted`).
- `POST /api/fleet/v1/host/turn {thread, state: "working" | "idle", turn: B22}`
  - The page's "working…" line. It's optional in the first slice and holds no body.
- **Reserved for M6** (the host lane's design): `POST /api/fleet/v1/host/audit/checkpoint`.
  - The host POSTs `sb.audit-checkpoint.v1` envelopes signed by its cert key: `{stream, epoch, seq, covers: {seq, digest}}`.
  - The service verifies them, stores them append-only per host, and answers a signed `sb.audit-ack.v1`.
  - The body and ack are defined by the M6 design. This note only reserves the route and puts the store in the same Worker.

#### The page's (session)

- `GET /api/fleet/v1/agents`: the directory. Each agent of each host in the person's fleet, read from the chain and grants: `{host, host_name, agent, name, status, last_turn_ms}`.
- `GET /api/fleet/v1/agents/<agent>/threads`: the threads, newest first.
- `POST /api/fleet/v1/agents/<agent>/messages {id, thread | null, body | sealed, priority, envelope}` (the envelope signed by a device of the fleet, §2; the thread's id is chosen by the page when it starts one, so the envelope can name it)
  - It creates the thread when the thread id is new.
  - It answers `{thread, inbox_seq, thread_seq, sent_ms}`. The dedupe key is (fleet, agent, `id`): a byte-identical resend returns the same answer; the same `id` with other content is refused `id_conflict`. A refused send consumes no seq.
- `DELETE /api/fleet/v1/threads/<thread>` (D2): the person deletes a thread.
  - The thread becomes a tombstone: `deleted_ms` is set, and its records' bodies and envelopes are erased. The metadata stays 30 days (`fleet`, `agent`, seqs, ids, kinds), then goes.
  - Its unacked messages leave the inbox at once. A host's poll never returns them, and an ack over them answers ok. The inbox seq keeps its gaps-free count by leaving the deleted seqs as `deleted` placeholders, which a poll returns as `{inbox_seq, deleted: true}` with no body, so the host's cursor moves past them.
  - A later reply into it is refused `thread_deleted`, including a turn that was running when the thread was deleted. The host records that and doesn't retry.
  - A thread id is never reused: after the 30-day tombstone the id alone stays (no metadata), so a new thread with it is refused `thread_conflict`.
  - Idempotent: deleting a deleted thread answers ok.
- `GET /api/fleet/v1/threads/<thread>?after=<thread_seq>&wait=<s>`: the thread's records after the cursor, as a long poll like the host's. It includes receipts (`acked_upto`) and the agent's turn state.

### 5. Storage, order and limits

- **One Durable Object per fleet** keeps the threads, both sequences, the cursors and the long polls. Its SQLite storage is the store. D1 keeps nothing of M7, and the DO checks host and agent through the Worker's existing grant lookup before it accepts a call. This is the same shape as the remote relay's per-notebook pages.
- **Order:** a send is one DO transaction that assigns both seqs. A long poll wakes when that transaction commits.
- **Retention:** a thread keeps every message until the person deletes the thread (§4, D2). Deleting an agent from the grant ends its inbox: messages to it are refused (`agent_revoked`), and its threads stay readable to the person.
- **Limits.** These are deployment variables, validated at start, with #1626 §5's starting values; none is a hard cutoff in code:
  - per sender: 60 a minute and 3,000 a day, for the page's sends and, per agent, for the host's replies;
  - 2,000 unacked messages per agent;
  - a body of at most 65,536 bytes of `md` (UTF-8) before sealing. A send's `ct` is at least 48 and at most 65,584 bytes (32 + `md` + 16), `enc` exactly 32 bytes; a reply's `ct` at most 65,536 + 16, its `nonce` exactly 12 bytes;
  - a thread list page of 100 (100 threads: one page; 101: two).

  Past a limit the answer is `limit` with `retry_ms`. Nothing is dropped silently. A deployment value that is missing, not a positive integer, or out of its documented range refuses the Worker's start for these routes (503 with the variable's name in the log), never a default guessed.

### 6. Bodies: sealed both ways (SEC's ruling on r2)

**Person to agent (HPKE).** The page seals each body to the host's X25519 `enc_key`, taken only from the host cert it verified against its pinned chain (never from the directory route), with core `hpke.mjs`, the suite fixed by r2.3 §7:
- `info = "sagebrush.msg.v1\n" + canon({fleet, host, host_gen, agent, thread, id, from, in_reply_to})`, so a body can't be moved to another thread, agent or message, and a body sealed to an old `enc_key` after a host re-key fails clearly;
- `aad` empty, as in `sealed.mjs`;
- the plaintext is binary, fixed layout (R4): the 32 bytes of `reply_key` (fresh CSPRNG bytes for this send), then the UTF-8 bytes of `md` (at most 65,536). No JSON, so no escaping changes its length: a send's `ct` is exactly 32 + len(md) + 16 bytes, at most 65,584. Vectors (a key, an `md` with 4-byte characters, the empty `md`) go in fleet-fixtures.json;
- `body_sha256` is over the `ct`; the service holds `{enc, ct}` and the metadata only;
- the host opens it in the supervisor; the plaintext reaches only the turn, never audit, logs or the activity line.

**Agent to person (AEAD under the reply key).** The host seals each `reply` with AES-256-GCM under its send's `reply_key` (`turn_failed` and `refused` records carry no body and need no key):
- a fresh 12-byte random `nonce` per record;
- `aad = "sagebrush.reply.v1\n" + canon(the sb.agent-reply.v1 envelope's body without body_sha256)`, so the reply is bound to its fleet, host, agent, thread, its id, `in_reply_to` and turn;
- `body_sha256` over the `ct`, and the envelope still host-signed (§2): authenticity is unchanged;
- a turn that folded several sends replies under the key of the **last verified** send it covered (its `in_reply_to`), never the last delivered (R2): a forged send, HPKE-sealed by anyone to the host's public key with a reply key they know, is refused (§7) and its key is never used;
- **The sealed reply is persisted before its first POST (R3).** The host writes the whole record (envelope, `nonce`, `ct`) durably, then POSTs it, and after a crash resends exactly those bytes. Re-sealing would draw a new nonce, and the resend would then be refused `id_conflict` and the reply lost.
- The reply key itself stays in the turn's memory only, never on disk, and is erased once the sealed record is persisted (it is never needed again: a resend uses the stored bytes). A crash before the record is persisted posts a `turn_failed`, which has no body. So there is no durable key store.

**The page and its keys.**
- The sending device writes each send's `reply_key` to IndexedDB (keyed by fleet, agent and message id), and that write completes BEFORE the send is POSTed (R4), so a page killed between the two never leaves a sent message whose reply can't be opened. Later the keys go in the person's E2E store, so the person's other devices can open replies once they sync.
- A device without the key shows "Sealed reply: open it on the device that sent the message", never the ct.
- A reply that fails to open (wrong key, AAD mismatch, tampered ct) is shown as unverified (§8, M3).

**Clear replies** are allowed by SEC only for a DEV-only first try, with a visible line in the thread ("Replies are visible to the Sagebrush service"), never in PROD. r4 doesn't use them: the first try is sealed both ways.

**Noted by SEC, for later:** any enrolled device, a browser tier included, may message an agent within its grant. The Agents page says so ("Any of your signed-in devices can wake this agent"). A per-agent "who may message" setting can come later.

### 6a. Rendering on the page

A body's markdown is rendered inert, with the page's existing chat sanitizer:
- no HTML passes through (script, iframe, style, event attributes are text);
- links are shown with their target and open only on a click, and only `https:`, decided after decoding entities and percent-escapes and trimming (no `javascript:`, `data:`, `http:` or other schemes; an entity-encoded `javascript:` is still refused);
- no remote fetch at render: images, iframes and embeds from a body aren't loaded (an image shows as a link), so a reply can't beacon.

### 7. The host's checks and wakes (the host lane's; recorded here for the contract)

**Before a turn, for each message (H1, H2):**
- the `sb.agent-message.v1` envelope verifies against the host's pinned chain: an enrolled, non-removed device, `chain_seq` at most the host's head (a `device_unknown` first runs a chain sync, then decides), and every field matching the record and this host and agent;
- `body_sha256` matches the `ct`, and the ct opens under the host's key with the bound `info`;
- the id isn't in the agent's durable set of processed ids;
- `at_ms` is within the retention window (default 7 days, a deployment variable) and at most 5 minutes in the host's future (`too_new` otherwise), so the window bounds both ends and the id set stays bounded. Processed ids are kept until `at_ms` + window and pruned only then (M1). Since `too_old` accepts a message while now ≤ `at_ms` + window, any earlier eviction would reopen a replay gap; `too_new` caps `at_ms` at now + 5 minutes, so the set stays bounded.
- `device_unknown` triggers at most one chain sync per wake, never one per message, so a flood of unknown-device sends can't drive syncs.

Anything that fails is refused: the host posts a `refused` record with a closed reason (`bad_signature`, `device_unknown`, `replayed`, `too_old`, `too_new`, `bad_body`) and acks it. It never runs a turn on it. **Only a verified envelope's id goes into the processed set:** an unverified message's id isn't burned, so a hostile service can't pre-burn a real message's id with a forged one.

**Wakes:**
- The supervisor long-polls each agent's inbox (or the host's, N3, later).
- A wake is a supervisor op and a widening intent on the host (`agent.turn`, with the digest of the message ids in its detail, N5). So without an anchored audit stream (M6) there's no turn, and the page shows the agent as "starting".
- One turn at a time per agent. Messages arriving during a turn are folded into the next turn's opening ("while you worked: …"), in the service's seq order (presentation only). At most one wake per 30 s per agent (#1626 §5).
- The turn's reply is POSTed as a signed `reply` record. Then the host acks up to the last message the turn covered.
- **A failed turn (N2):** a turn that ends with no reply (a crash, or a refused start) posts a `turn_failed` record with a closed reason (`crashed`, `start_refused`, `budget`, `stopped`), never text from the model, then acks. So a message is never redelivered forever.
- **The service's word is advisory (N4):** `host_revoked`, `agent_revoked` or `not_granted` from the service makes the host run a chain sync and its grant intake. It never stops an agent on the service's word alone; the chain decides.
- **Plaintext:** the plaintext reaches only the turn: never the audit stream, logs or the activity line (N5).

### 8. Rows (acceptance), for the service and page

**Auth:**
- a host's request for an agent outside its latest issued grant, unsigned, replayed (nonce), or revoked: each refused with its code;
- gen edges (T1): the latest gen ok; the previous gen ok while the grant-ack is outstanding, refused (`stale_generation`) once the ack for the latest is in; two back refused; a gen ahead of the latest issued refused;
- `agent: -` on a one-agent route refused (`bad_form`); another host's agent in the same fleet refused (`not_granted`);
- every page route (the directory, the thread list, send, read a thread, delete a thread) without a session, and with another account's fleet or thread: refused alike, and nothing changes (for delete: nothing tombstoned) (U3); mutant: delete without its ownership check is caught.

**Threads (T2, T5):**
- a host reply into another agent's thread, or another host's: refused `not_found`, the same as an unknown thread;
- a new thread id that exists for another agent, host or fleet: refused `thread_conflict`, never joined;
- a deleted thread: sends and replies refused `thread_deleted`, also for a turn running at the delete; its unacked messages become `deleted` placeholders; the cursor moves past them; delete is idempotent (D2);
- a thread id after its 30-day tombstone: a new thread with it refused `thread_conflict`.

**The subject (U2):** 120 characters accepted and 121 refused, counted in characters with 4-byte ones at the edge; a subject not in NFC refused (`bad_form`), never normalized silently; control characters refused; empty accepted (the thread shows its first send time); the page shows "Visible to the Sagebrush service" beside the field; a host's inbox record carries no subject, and a subject rewritten in the service's store never appears in a turn (U1, a host row).

**Idempotency (T3):**
- a byte-identical page send resent: one message, the same answer;
- the same id with other content: `id_conflict`, nothing stored;
- a host reply resent, byte-identical: one reply; with other content: `id_conflict`;
- two racing sends with the same id: one row;
- the reply's dedupe key is (fleet, agent, id).

**Kind and direction (T4):** the page posting `reply`, `turn_failed` or `refused`: `bad_kind`; the host posting `message`: `bad_kind`; a `reason` outside its kind's closed set, or set on `message` or `reply`: `bad_form`.

**Envelopes (T11, service side):**
- a send without an envelope, with an extra or missing field, or with a field that differs from the request: refused before storage;
- a `body_sha256` that doesn't match the ct: `bad_body`;
- a reply likewise.

**Order and paging (T6):**
- the inbox seq and thread seq are gap-free under concurrent sends;
- a refused send consumes no seq;
- `after` = 0, = the last seq, and past the last seq: exactly the later records, none, none;
- 64 messages: one page, `more: false`; 65: two pages, the second with one record; never an empty page with `more: true`; the 1 MiB bound likewise at its edge;
- mutant: ack applied by thread seq instead of inbox seq is caught.

**Long poll (T7):** it wakes on a send's commit and answers empty at `wait`; a send between two polls isn't missed (the cursor, not the wake, decides); an agent revoked during a held poll gets the refusal and no messages; a DO evicted mid-poll loses nothing.

**Ack (T8, U4):** idempotent; never backwards; `upto` past the highest delivered seq: `ack_ahead`; deliver, evict the DO, then ack up to the delivered seq: ok (the high-water mark is durable); the page sees `acked_upto`.

**Limits (T9):**
- a body of exactly 64 KiB of UTF-8 accepted, one byte more refused, with 4-byte characters at the edge;
- a send's ct of 65,584 bytes accepted, 65,585 refused, 47 refused (shorter than an empty `md` needs); a reply's ct of 64 KiB + 16 accepted, one more refused; an `enc` of 31 or 33 bytes, or a `nonce` of 11 or 13, refused;
- the 2,000-unacked bound at its edge, and acking frees it;
- each rate limit at its edge, with `retry_ms`;
- an invalid deployment value refuses start: a table-driven row over every variable (missing, 0, negative, not an integer, out of range);
- the host's replies are rate-limited per agent, at the edge.

**Reply keys (SEC's ruling):**
- each send's plaintext carries a fresh 32-byte reply key: two sends never share one (a row over 1,000 sends);
- the sending device stores it under (fleet, agent, message id) and opens the reply; a second device without it shows "open it on the device that sent the message" and no ct;
- a reply to a folded turn opens under the last VERIFIED covered send's key and not under an earlier one's; a fold whose last message is forged (refused) replies under the last verified send's key, and the forged key opens nothing (R2);
- the host persists the sealed reply before its first POST; a crash after the persist resends the same bytes and the service answers the first answer; mutant: re-sealing on resend is caught by `id_conflict` (R3);
- the page writes the reply key before POSTing the send; killing the page between them leaves no sent message without its key (R4);
- `refused` and `turn_failed` records have no body and need no key; after a host restart mid-turn, a `turn_failed` is posted with no body (no key was persisted).

**Sealing (T10, M2):**
- the service's stored thread holds no bytes of any body (a row inspects the stored records, the subject included) (M2);
- a reply sealed under another send's reply key, or with its AAD changed (another thread, id, in_reply_to or turn), fails to open;
- a body moved to another thread, agent, message id, sender or in_reply_to fails to open (`info` binds each);
- a body sealed under an old `host_gen` fails after a re-key (N6);
- the page seals to the `enc_key` of the cert it verified, and ignores any key in the directory's answer (a row serves a different key there);
- the service never sees plaintext or a plaintext hash (a row inspects the stored record).

**The page's checks (T12, T13):**
- the page accepts a reply only if its envelope's thread, agent and `in_reply_to` match the thread on screen, and `in_reply_to` names a message of this thread (M3); a valid reply envelope re-posted into another thread shows as unverified;
- a reply shows as unverified when its sb.agent-reply.v1 is signed by ANOTHER host of the same fleet, over a ct whose hash doesn't match, or signed by a removed host; or when its ct doesn't open under the send's reply key (wrong key, AAD mismatch, tampered);
- on a device without the send's reply key, a reply shows "open it on the device that sent the message", and no ct;
- a `turn_failed` or `refused` record shows its closed reason and no body;
- a body with `<script>`, an event attribute, `javascript:`, `data:`, `http:` and entity-encoded `javascript:` links, and remote `<img>`/`<iframe>` renders inert, and loads nothing (a row counts the page's requests);
- one mutant per signed field of sb.agent-reply.v1 (fleet, host, agent, thread, id, in_reply_to, turn, kind, at_ms, chain_seq, body_sha256): the page's verification catches each.

**The page (T14):** send, see the message, see "seen", see the reply arrive by long poll; a reload keeps the thread (from cursor 0); a reload mid-turn shows the "working" line again and then the reply once.

**Revocation:** an agent removed from the latest issued grant refuses sends and inbox reads at once, while its threads stay readable to the person.

**Host-side rows** (the host lane's, listed for completeness): a replayed id, a too-old or too-new at_ms, a forged or unknown device, a body hash mismatch: each refused with its record, acked, no turn; a forged message carrying a real message's id doesn't burn it (the real one, arriving later, runs); one chain sync per wake under a flood of unknown-device sends; processed ids pruned at at_ms + window; an id received before its at_ms (up to 5 min ahead) and replayed in the last 5 minutes of its window is still refused `replayed`; a future-dated message (more than 5 min ahead) refused too_new and never runs a turn (M1); a crashed turn posts turn_failed then acks; a service revoke alone never stops an agent.

### 9. Open items

1. **SEC: settled** (on r2): sealed both ways, §6; conditions M1-M3 in §7 and §8.
2. **Not needed:** a person-device `enc_key` in the chain. The reply key makes replies sealed without it. The person's E2E store syncing reply keys across devices is later work.
2a. **Core schemas lane:** the closed schemas `sb.agent-message.v1` and `sb.agent-reply.v1` in fleet.schema.json, with vectors in fleet-fixtures.json.
2b. **The page's device signing** (fleet-device.ts), shared with M4's pairing approval: one dependency for both.
3. **Host lane:** the M6 checkpoint body and ack (§4, reserved route).
4. **Deploy:** the fleet Worker isn't deployed on DEV (every `/api/fleet/v1` route answers 404). The first try needs it there with this DO bound, and D1 migrations for the fleet DB per the usual DEV-first rule.
5. **The live channel** (browser channel r4.2): a turn's progress streamed to an open page, later, as a new frame kind there, not a second transport.

---

## Agent messages (M7): r7, a delta on r6 (a372fb35) for William's rulings on the #1626 limits (Nov 27)

Everything in r6 stands except what this changes. The four rulings:

### 1. No fixed turn time limit

- No wall-clock cap on a turn, and no 2 h default anywhere (r6 had none in the service; the host's design drops #1626's).
- A turn ends by:
  - its own finish;
  - the person's Stop;
  - the agent's daily SPEND budget, set by its owner, running out;
  - stall detection: no model output, tool progress or tool result for the host's stall interval.
- The closed `turn_failed` reasons (§7) become: `crashed`, `start_refused`, `budget`, `stalled`, `stopped`. `budget` now means the daily spend budget.
- The stall interval and the spend budget are the host's configuration (the host lane's design). They're shown to the person; neither is a cutoff of the service's.

### 2. Messages reach an agent mid-turn (REQUIRED)

This replaces r6 §7's "messages arriving during a turn are folded into the next turn's opening".
- **Delivery doesn't depend on the turn.** The supervisor's inbox poll runs whether or not a turn is running. A long turn never blocks delivery.
- **A verified message arriving while a turn runs** is given to that turn at once, as a steer. sagebrush-agent's `chat.steer` puts the person's text into the running turn's input, between model steps. A message arriving with no turn running starts one (a wake), as before.
- **Ack:** the host acks a message once it has been delivered (handed to a running turn, or used to start one), not once a reply exists. So "seen" on the page means "the agent has it now".
- **Replies:** a turn that took steers replies under the reply key of the LAST VERIFIED send it covered (r6 §6's rule; a steered message is a covered send).
- The one-wake-per-30-s bound (§5) limits starting turns, never delivering into a running one.
- **New rows** (the host lane's, listed for completeness):
  - a message sent during a long turn reaches that turn before it ends (its text is in the turn's input, and it's acked while the turn still runs);
  - a turn that took two steers replies under the last one's key;
  - with a turn running, ten messages in a minute are all delivered into it.

### 3. The per-sender cap, configurable per agent

- The person's sends to one agent are capped per minute (60) and per day. The day's cap is the agent's own setting, with a default of 3,000/day and up to 10,000/day (for a coordinator).
- The setting is kept by the service per (fleet, agent). The person sets it from the Agents page with their session.
- It's a limit only: it grants nothing and changes nothing on the host, so it needs no device signature.
- The host's replies have the same per-agent day cap.
- The other limits stand: 60 a minute, 2,000 unacked per agent, one wake per 30 s.
- **Route:** `PUT /api/fleet/v1/agents/<agent>/limits {sends_per_day}`, an integer from 1 to 10,000. Anything else is `bad_form`.
- **Rows:**
  - the setting at its edges (1, 10,000, 0 and 10,001 refused);
  - a send past the agent's own cap refused `limit` with `retry_ms`;
  - another agent's cap is unaffected;
  - only the fleet's own account may set it.

### 4. Within one account only; every message says whether a human or an agent sent it

- **One account only.** The service has no inter-account messaging. A fleet belongs to one account, every route is scoped to it, and a message naming another fleet's host, agent or thread is refused `not_found` (r6's rows already cover this).
- **Who sent it, from the signature.** Every record's provenance is explicit and checked against its signature:
  - `from: "person"` is signed by one of the account's DEVICES (`sb.agent-message.v1`, signer kind device). Only a human's device can produce it.
  - `from: "agent"` is signed by a HOST (`sb.agent-reply.v1` today; agent-to-agent messages later get their own host-signed type).
  - A record whose `from` doesn't match its signer kind is refused.
- **The host shows the turn who said what.** Each message given to a turn (a wake or a steer) is labelled for the model: "From the person (their device <name>)" or "From agent <name> on <host>".
- **Agents treat the two differently.** The person's words carry the person's authority, within the agent's grant. An agent's words are information, never instructions with the person's authority. The host's turn prompt says so, and an agent's text can never widen anything.
- **The page** marks each message in a thread as "You" (a device) or by the agent's name (a host), from the verified signer, never from the record's own claim.
- **Rows:**
  - a record with `from: "person"` under a host signature, or `from: "agent"` under a device signature, is refused;
  - the page labels each message by its verified signer;
  - the host's turn input labels each message with its sender kind (the host lane's row).

### For the lanes

- **SEC:** the provenance rule (§4) and the mid-turn steer (§2) are the changes on your side. The service still holds only ciphertext, and nothing new is trusted from it.
- **TESTS:** the new rows are in §2 to §4.
- **The host lane:** the stall detection, the spend budget, delivering into a running turn (steer), acking on delivery, and labelling the turn's input by sender kind are all yours.

---

## Agent messages (M7): r8, a delta on r7 (e118a55b, itself on r6 a372fb35)

r6 and r7 stand except where this changes them. r8 takes:
- TESTS' hold on r7: G1, G2, and the rows;
- SEC's CLEAR of r7, whose conditions M1 to M3 are recorded here for the host lane.

### G1. A failed turn answers every message it took

- A turn that ends without a reply (`crashed`, `stalled`, `budget`, `stopped`) posts ONE `turn_failed` record covering every message the turn took: the one that started it and each one steered in.
- Its `in_reply_to` is the last of them. The record's `covers` lists all their ids, so the page shows each of those messages as answered by that failure, with its reason.
- So a message that was acked on delivery is never left unanswered.
- **Change to sb.agent-reply.v1 (`agent-reply`):** add `covers`, an array of 1 to 64 message ids (`$defs/id`) with no repeats. `in_reply_to` must be its last element.
  - It's required on `turn_failed` and on `reply` (the messages the reply answers).
  - It's absent (null) on `refused`, which answers exactly its `in_reply_to`.
- **Rows:**
  - a steer, then a crash: `turn_failed` covers both the starting message and the steer;
  - the same for `stalled`, `budget` and `stopped`;
  - a `covers` without its `in_reply_to` last, with a repeat, or with 65 ids: `bad_form`.

### G2. A redelivery of a delivered message is acked, not refused

- The host keeps, with each processed id, the SHA-256 of the envelope it verified.
- A redelivery carrying the same id:
  - with the **same envelope bytes:** acked silently, with no turn and no record. This is the case of a crash after delivery but before the ack landed.
  - with **different envelope bytes:** refused `replayed`, as before. That's a different message reusing an id.
- A steer whose ack didn't land before a crash is redelivered after the restart and acked this way. It isn't redelivered into a new turn: the crashed turn's `turn_failed` (G1) has already answered it. If the crash came before that record was persisted, the record is posted after the restart, from the host's durable list of the turn's covered ids.
- **Rows:**
  - a crash between the steer and its ack: the redelivery is acked silently and the message is answered once, by `turn_failed`;
  - a different envelope with a processed id: refused `replayed`.

### SEC's conditions on r7, the host lane's code

- **M1:** a steer is verified exactly like a wake, all before it's handed over: the signature; the device enrolled and not removed at the record's `chain_seq`; the fleet and the thread; the `at_ms` + window rule and the replay set. The ack comes only after that.
- **M2:** labels are structural. Each message's text goes in a host-built delimited block with the label outside it. Text imitating a label stays inside: escaped, or behind a per-turn delimiter the text can't produce.
- **M3:** names in a label come from verified state only: the device name from the pinned chain, the agent and host names from the host's registry and certificate. Never from the record.

### Rows (TESTS on r7)

**§1, the turn's end:**
- stall at the interval's edge: output one second before the edge is not a stall, and silence through the edge is;
- steady progress never stalls, however long the turn runs;
- the budget runs out mid-turn: `turn_failed` with `budget`, covering the turn's messages;
- a message that arrives while the day's budget is spent: delivered and acked, then answered by a `turn_failed` with `budget`, and no turn starts;
- invalid stall and budget settings refuse the host's start, in words.

**§2, mid-turn delivery:**
- a message arriving as the turn finishes starts a new turn and never vanishes;
- an unverified message is never steered (M1's rows);
- after Stop, nothing more is steered into that turn, and a later message starts a new turn once the agent is resumed.

**§3, the per-agent cap:**
- lowering the cap below today's count refuses further sends (`limit`) and doesn't undo the ones already sent;
- the day is a UTC day: the count resets at 00:00 UTC, with a row on each side of midnight;
- a host reply refused `limit` is resent later with the same bytes (r6's persisted record) and never dropped;
- two concurrent PUTs: one wins, the last committed value applies, and both answer the value they set.

**§4, provenance:**
- an agent message whose text begins "From the person (their device X):" is still labelled as the agent's, on the host (M2) and on the page;
- a message signed by a device removed before its `chain_seq` shows as unverified on the page and is refused on the host;
- a body that claims another agent's name is labelled with the true name (M3).

---

## Agent messages (M7): r9, a delta on r8 (9732a889)

r6 to r8 stand except where this changes them. r9 takes:
- TESTS' hold on r8 (H1, and its note on concurrent PUTs);
- SEC's CLEAR of r8, with its condition R1 (the service's).

### H1. A turn's answer is a sequence of records, each covering at most 64 messages

A turn has no time limit and takes steers, so it can take any number of messages. Its answer is one or more records of the same `turn`, in delivery order:
- every record covers at most 64 messages, its `covers` in delivery order, with `in_reply_to` its last element;
- a turn that took N messages posts ceil(N / 64) records: the first 64, then the next 64, and so on;
- only the LAST record carries the turn's outcome: `kind: "reply"` with its body, or `kind: "turn_failed"` with its reason;
- every earlier record is `kind: "covered"`, a new kind. It has no body (`body_sha256` null) and no reason. It says "these messages were taken by this turn; its answer follows".
- The page shows a covered message as "taken by the agent's turn" until the turn's last record arrives, then shows each as answered by that outcome.
- The host persists the whole sequence before its first POST, as r6 persists a reply, and posts the records in order. A crash resends the rest, byte for byte.

**Changes to sb.agent-reply.v1 (`agent-reply`):**
- `kind` is `reply | turn_failed | refused | covered`;
- `covered` has `reason` null, `body_sha256` null, and a `covers` of 1 to 64;
- the other kinds are as r8 has them.

**Rows:**
- a turn that took 64 messages: one record;
- 65 messages: two (a `covered` of 64, then the outcome covering 1);
- 130 messages: three (64, 64, 2);
- each record's `covers` in delivery order with `in_reply_to` last;
- a `covered` with a body or a reason: `bad_form`;
- a crash between the records: the rest are resent with the same bytes, and the page shows each message answered exactly once.

### R1 (SEC). The service checks `covers` against its own records

Before it stores a `reply`, `turn_failed` or `covered` record, the service checks that every id in `covers`:
- is a message in the SAME fleet and the SAME thread as the record;
- is addressed to an agent of the signing host (the record's own `agent`);
- was delivered to that host (its inbox seq is at or below the host's delivered high-water mark).

Any other record is refused `bad_covers` (closed), and nothing is stored. A host can mark only its own delivered messages as answered.

**Rows:**
- a covers id from another thread: `bad_covers`;
- one addressed to another host's agent: `bad_covers`;
- one never delivered: `bad_covers`;
- a valid `covers`: stored, and the page shows each message as answered.

### The per-agent cap's PUT (TESTS' note)

- `PUT /api/fleet/v1/agents/<agent>/limits` answers the COMMITTED value and its `version` (a counter, starting at 1), never the value the caller sent.
- A PUT may carry `if_version` and is then refused `conflict` if the version has moved on.
- **Row:** two concurrent PUTs, where both answers name the same committed value and version.

---

## Agent messages (M7): r10, a delta on r9 (3be5c3cc)

r6 to r9 stand except where this changes them. r10 takes TESTS' hold on r9: X1, the resend-loop row, and the PUT rows.

### X1. A turn's answer is split by thread as well as by 64

r7 steers any verified message for the agent into its running turn, whatever its thread. That's William's rule that a long turn never blocks delivery, so steering stays as it is. The answer is split instead, so that every record stays inside one thread (R1's same-thread rule holds as written):
- **For each thread the turn took messages from,** the host posts that thread's own sequence: its messages in delivery order, at most 64 per record, with `in_reply_to` the last of each record (r9).
- **The answering thread** is the one holding the turn's last verified delivered message (r6's reply-key rule). Its last record carries the outcome: `reply` with the body, or `turn_failed`.
- **Every other thread:**
  - **after a `reply`:** its last record is `covered` with `answer: {thread, id}`, naming the answering thread and the reply record's id. The host chooses the id before posting anything. The page shows those messages as "answered in <thread>", with a link.
  - **after a `turn_failed`:** each thread gets its own `turn_failed`, with the same reason and its own `covers`, so each thread shows the failure where its messages are.
- **The order of posting:** the answering thread's records first, then the others'. All of them are persisted before the first POST (r9).
- **Schema (sb.agent-reply.v1):** `answer` is `null`, or `{thread: id, id: id}` on a `covered` record. It's null on every other kind.
- **R1 also checks `answer`:** it must name a `reply` record, by the same host, for the same agent and the same turn, stored or posted in this same sequence. Otherwise the record is refused `bad_covers`.
- **Rows:**
  - a turn started in thread A that takes a steer from thread B: A's records end in the reply; B gets a `covered` with `answer` naming A's reply; both are stored (no `bad_covers`); the page shows B's message as answered in A;
  - the same turn failing: A and B each get a `turn_failed` with the same reason;
  - three threads, one of them taking 65 messages: each thread's records stay at 64 or fewer, in delivery order;
  - an `answer` naming another turn's or another agent's reply: `bad_covers`.

### A permanently refused record never wedges the resend loop

- The host treats a closed refusal from the service as permanent: `bad_covers`, `bad_form`, `bad_kind`, `id_conflict`, `thread_deleted` or `not_found`. It means the record will never be stored.
- That record leaves the resend queue and is written to the host's own log, with the closed code and the record's id (never its body). The rest of the sequence, and every other record, still posts.
- Only `limit` (retried at `retry_ms`) and transport failures are retried.
- **Rows:**
  - a sequence whose second record is refused `bad_covers`: its third still posts, and the next turn's records post;
  - a refused record isn't resent;
  - a `limit` refusal is retried with the same bytes and then stored.

### The PUT rows, corrected

- PUTs are serialized by the Durable Object, so two of them commit as versions n and n+1 in commit order. Each answers the version it committed, and a read afterwards answers n+1 with the later value.
- With `if_version: n` from the same base, exactly one of the two commits (n+1), and the other is refused `conflict` with the current value and version.

---

## Agent messages (M7): r11, a delta on r10 (bc918563)

r6 to r10 stand except where this changes them. r11 writes down two closed record reasons agreed in review (TESTS' C1 on r10, and the host's refusal of a misaddressed message) that the schema of sb.agent-reply.v1 already carries, and one line about `aud`. Nothing else changes.

### The closed reasons, in full

- `turn_failed`: `crashed`, `start_refused`, `budget`, `stalled`, `stopped`, **`answer_lost`**.
- `refused`: `bad_signature`, `device_unknown`, `replayed`, `too_old`, `too_new`, `bad_body`, **`not_granted`**.
- `reply` and `covered` carry no reason (`reason: null`), as before.

### `answer_lost` (turn_failed): the answering thread's outcome never stored

- **When the host posts it:** r10 X1 makes the other threads of a split answer end in `covered`, with `answer` naming the answering thread's `reply`. If that `reply` (or the answering thread's `turn_failed`) is permanently refused by the service (r10's list: e.g. `thread_deleted` because the person deleted the answering thread mid-turn), no stored record answers those threads' messages. The host then ends each other thread with its own `turn_failed`, reason `answer_lost`, with that thread's own `covers` and the same `turn`, instead of a `covered` naming a record that was never stored.
- `covered` records already stored in those threads stand. Only each thread's last record changes, so every acked message is still answered exactly once.
- The host builds these records when the permanent refusal arrives, persists them before the first POST (r9), and posts them in thread order.
- **What the page shows:** on each covered message, "The agent's answer was lost (its thread was deleted). Send it again to ask again." No body, no link.
- **Rows:**
  - a turn in thread A takes a steer from thread B; A is deleted before A's reply posts: B gets a stored `turn_failed` with `answer_lost` covering B's messages, never `bad_covers`; the page shows B's message as lost, not as answered;
  - the same with B's `covered` already stored before A's refusal: that `covered` stands and B's last record is the `answer_lost` one;
  - the verifier accepts `answer_lost` only on `turn_failed` (a `refused` with it is `bad_form`).

### `not_granted` (refused): a verified message not for this host's agent

- **When the host posts it:** a delivered `sb.agent-message.v1` whose signature and device check out but whose `host` or `agent` isn't this host's granted agent (core `verifyAgentMessage` answers `not_granted`). The service shouldn't route one (r6 §2), so this is the host's own check holding when the service is wrong. The host posts one `refused` record, `in_reply_to` the message's id, no `covers`, no `turn`, no body, and never starts a turn for it.
- It doesn't stop the agent and doesn't change any grant: as r6 N4 has it for the service's `not_granted`, the chain decides; the host runs a chain sync and its grant intake.
- **What the page shows:** on that message, "Not delivered: this agent isn't on that host any more." The page offers to refresh the directory.
- **Rows:**
  - a message naming another agent of the same host, or another host's agent, delivered to this host: one `refused` `not_granted` record, no turn;
  - the verifier accepts `not_granted` only on `refused` (a `turn_failed` with it is `bad_form`).

### `aud` in every body

- Both bodies carry `aud`, the service's audience, as every fleet body does. It's checked by core `open` against the verifier's `ctx.aud`. r6 §2's field lists omit it; they should be read with it.
