# Agent messages (M7): the wire contract between the page, the fleet Worker and a host

*Status: cleared design; not built in this repository yet. This file is the reviewed text: r6, then its deltas r7 to r11 and r12 to r12.10 (the scale revision: William's "hundreds of agents", Nov 28 2026) in order, each standing except where a later one changes it. A delta's text wins over the revisions before it. The sha256 of each reviewed revision is in the table below; the text here differs from those bytes only in heading levels, in naming reviewers by lane (SEC, TESTS) rather than by name, and in two rows corrected in review (r10 X1's first row and r11's first answer_lost row now add a later message in thread A, so that A holds the turn's last verified message and is the answering thread, as r6's reply-key rule and X1 say). The schemas and verifiers are in sagebrush-agent (`schema/fleet/fleet.schema.json`, the bodies `agent-message` and `agent-reply`; `lib/fleet/core/verify.mjs`, `verifyAgentMessage` and `verifyAgentReply`). This repository's copy of the fleet core moves with its mirror pin, not with this file.*

| Revision | sha256 | What it settles |
|---|---|---|
| r6 | `a372fb354232bd17fff97a7a65aac423969b87a56846c537b0676f85ba68ca90` | the contract: records, routes, sealing both ways, the host's checks, rows |
| r7 | `e118a55b40c16155d7588afe47cea6c711a274ce37f7a8e13a73d684f51cb15b` | the limits rulings: no turn time limit, steering into a running turn, the turn_failed reasons |
| r8 | `9732a889a4cfd093236f9ea0d6bd82e064e9d03f8f5ced51cd2187b15b490e55` | one turn_failed covering every message a turn took (G1), redelivery after a crash |
| r9 | `3be5c3cc1c96c2165ef7a927852f30356df9134d3a2b29694076f14a8551be7c` | a turn's answer as a sequence of records of at most 64, persisted before the first POST |
| r10 | `bc9185630b7fe1d0c1a6aa2bc37dff88563ba1ab13cd3cb08ce056786fddd006` | answers split by thread (X1), permanent refusals leave the resend loop, the PUT rows |
| r11 | `c24c03c33519217dd8054294e631d926dde1c1bfe26abe756ddd99f56695b397` | the closed reasons answer_lost and not_granted, and aud in every body |
| r12 | `3d86cd79529cd163438904fd47bea90b1bf2d71f3f7a4f7ff6820ca7d65e0eca` | scale: one DO per agent plus a fleet directory, one hint channel per host, budget-derived limits, back-off, queued wakes, the load test |
| r12.1 | `c7db3274e25285756c8ad6beca2edc465f72110ad5a616a76831d27b9b9513f1` | fleet-scoped thread ids, claims never released, storage leases, durable notifies, `heads` from the agent DOs, certified `through` (no deleted ranges) |
| r12.2 | `6e3eba76f03889710be1adff4d6538216135c01ecdc450a063dbb83b4874682f` | small, growing, fair-share leases with recall; answer reserves; heads weighted; notify coalescing; the 1 MiB cut; jitter cap; the PROD-bundle row |
| r12.3 | `1eef54be1ff0f511ddbd76babb5c5aff2f08bc97cc9573e5b5a9275444408eb7` | one snapshot per poll, versioned notify clearing, the reconnect window; the answer_lost reserve; enforced covers and size; the reserve start check |
| r12.4 | `eaacf9884f35385fed15dfa429a30403c8f1f87e601a7714117536aed7b1e0b7` | answer_lost only against its reserve; a lease covers its send; idle recall and the slack start check; checkable property rows (its E3 replaced by r12.5) |
| r12.5 | `26f57ae81680683b97e0ffd5eb264546a962cc9541cbf5cce6a25a4fccc0c76c` | held bytes bounded per agent and per host (held-credit leases) and by an age-keyed stale pool |
| r12.6 | `77aa255d2bc5974fac51c1a5aa643321336dbf3f9e530392f3be9260db0efc69` | the certified-deletion property (G2); its G1 bound superseded |
| r12.7 | `5304b98f25a6b08e88673a6c58fd25d5ded17f39bc4c8532cf1dd000bc2cea6a` | re-grant moves held bytes (R1, refined by r12.10); its G1 bound superseded |
| r12.8 | `f4955e8792bfbac9cb9c2d66c7517898b8008738e3ab29d7ad940e8c400df722` | withdrawn |
| r12.9 | `ae8f73ed8a77473e951259dd373cbab63aa7bf3bbca31fe99ee3512c0001331f` | withdrawn in favour of the folded G1 wording below |
| r12.10 | `70e79855b5f261a2d0e5212b1edcf5c501ab48848c524ba10bb39adb07e54ffd` | held credit moves on re-grant only atomically, when it fits the new host's cap |

## Conditions carried into the service and the page (from the reviews of the schemas and of r11)

These hold in addition to the text below, and each comes with its row in the PR that builds it.

- **R1 covers `refused` records too (SEC).** r11 has the host post a `refused` record with `not_granted`, whose `in_reply_to` names a message that wasn't for its agent. A `refused` record marks that message on the page, so before storing one the service checks that its `in_reply_to` is a message delivered to THIS host: the same fleet, at or below the host's delivered high-water mark. Otherwise the record is refused `bad_covers` and nothing is stored. Without this check one host could mark another host's messages refused.
  - Row: a `refused` record naming a message delivered to another host is `bad_covers`, and nothing is stored.
- **r11's `not_granted` row (TESTS).** A `refused not_granted` for a message naming ANOTHER agent sits in that agent's thread, so the service refuses it `not_found` (r3 §4) and the host takes r10's permanent-refusal path: the record leaves the resend queue and is logged with its closed code and id. r11's first `not_granted` row expects exactly that for the other-agent case.
- **The callers' checks (SEC).** The verifiers leave three checks to their callers, each with rows in the PR that calls them: a reply's agent is one the host owns, and its `covers` and `answer` pass R1 (the service); the host's certificate is valid at the record's `chain_seq` (every caller).
- **The page signs only this type (SEC).** The page signs `sb.agent-message.v1` through the same signing barrier as every other device-signed type: the body built from typed inputs, a grant minted for those exact bytes. The message path never signs any other type. Row: the message path refuses to sign a body whose type isn't `sb.agent-message.v1`.
- **r12's k-host guarantee (G1), as folded (Codex's ruling on r12.10; SEC: either form, if S's definition matches it).** This text replaces r12.6, r12.7 and r12.9's G1 statements.
  - **What it bounds:** only unanswered (held) credit, within the budget that remains after durable history (answered records, kept until their threads are deleted) and leased slack. It promises no fleet storage headroom; that is the storage budget's job (r12.1 C3, r12.2 L1, r12.4 E1).
  - **S** is every host owning any stale credit (held past `stale_after_ms`), whether or not it answers its other agents, and k = |S|. S's held bytes are at most k x `host_held_bytes_max`, with no exception (r12.10: a re-grant moves credit only when it fits).
  - **The bound:** the hosts outside S can hold new unanswered messages up to (the budget remaining after durable history and slack) - max(`stale_pool_bytes`, S's held bytes), floored at 0. At the defaults, with nothing else stored, that is at least 75% for k <= 2, 50% for k = 5, and 0 from k = 10.
  - **It is collective (TESTS):** it bounds the hosts outside S together, never one host among several. A slow host whose backlog has aged is in S.
  - **k counts owners (SEC):** S is the hosts that OWN stale credit, so one misbehaving host can account for several of the k while re-granted credit waits to move (r12.10: a host stopping with re-granted agents whose credit is still owned by three other hosts makes k = 4). "k = 1 leaves 75%" therefore isn't "one bad host leaves 75%" while credit is moving. The Agents page shows the computed k, and the owners it counts, beside the "moving" agents.
  - **Rows:**
    - answered history, then stale: budget 100, S holding 90 of answered records plus 1 held byte that goes stale. The others are bounded by the 9 free, and G1 claims nothing beyond the remaining budget;
    - one healthy host beside 3 slow-but-answering hosts whose backlogs age past the pool: the 3 are in S (k = 3), and the healthy host, alone outside S, can hold up to (the remaining budget) - max(`stale_pool_bytes`, the 3's held bytes): at least 70% at the defaults with nothing else stored;
    - two healthy hosts outside S: the bound is for the two together, and neither alone is promised a share;
    - a host stopping while holding re-granted agents whose credit three other hosts still own: k = 4, and the Agents page shows k and its owners;
    - k = 1, 2 and 5 at the defaults; r12.10's re-grant rows.
- **Carried to the PR that builds the service (from SEC and Codex on r12.x):**
  - N2 to N5 (r12.1: the channel's identity from its attachment, client frames bounded, one socket per host, grant changes closing the channel) and N8 (the host's page checks, with r12.3 F1's after <= through <= head);
  - every row of r12 to r12.10, the transaction, alarm and restart rows run against the real DO code, and the 500-agent / 50-host load gates of r12.1 T3 run for real (Codex: the design models pass; these gates remain).

---

## Agent messages (M7): the wire contract between the page, the fleet Worker and a host (draft r6)

Status: draft r6. Nothing is built. r6 takes TESTS' hold on r4 (R1-R5; R1 and R5 were already met in r5): a fold replies under the last VERIFIED send's key (R2), the sealed reply persisted before its first POST (R3), the page storing the reply key before the send and the plaintext's exact encoding (R4). SEC cleared r4 with the pruning correction r5 already has. r5 took SEC's CLEAR of r3 (f4eb69cb) and TESTS' holds on r3 (U1-U4, and their notes as rows), and settles the id set's pruning at at_ms + window (the host lane's point on r4; SEC's r3 verdict states the same). r4 took SEC's clearance of r2 (cd2bfbff) with its §6 ruling and conditions M1-M3: sends sealed now, replies sealed under a per-send reply key, clear replies only for a DEV first try (not taken: sealed replies were chosen from the start). r3 took TESTS' hold on r2 (cd2bfbff): the subject's source (D1), deleting a thread (D2), and the rows T1-T14; and the host lane's three precisions on r2 (only verified ids burned, too_new, one sync per wake). r2 took the host lane's review of r1 (6075e7eb): sends are device-signed (H1), the host's own replay and order checks (H2), host-signed replies (H3), and N1-N6. It implements the first slice of the autonomous-agents design (#1626 §4 message wakes, §5 messages, §7 the thread and reply box), shaped to the fleet as built: hosts paired into a fleet chain, agents granted by the chain, units started by the supervisor.

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
  - a turn started in thread A that takes a steer from thread B, then a later message from A (so A holds the last verified message and answers): A's records end in the reply; B gets a `covered` with `answer` naming A's reply; both are stored (no `bad_covers`); the page shows B's message as answered in A;
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
  - a turn in thread A takes a steer from thread B, then a later message from A (A answers); A is deleted before A's reply posts: B gets a stored `turn_failed` with `answer_lost` covering B's messages, never `bad_covers`; the page shows B's message as lost, not as answered;
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

---

## Agent messages (M7): r12, a delta on r11 (c24c03c3) for scale: hundreds of agents (Nov 28)

r6 to r11 stand except where this changes them. r12 takes William's requirement of Nov 28 2026: "also target real scalability for autonomous agents, eg you clearly can make use of hundreds of agents potentially. no tiny limits right." So the service and the host are designed and tested for hundreds of concurrent agents across many hosts in one fleet:
- no fleet-wide serialization point on the message path;
- no fixed small caps; every limit comes from a measured budget, has a documented default and range, and refuses clearly;
- cost per message stays constant as the number of agents grows;
- back-pressure and back-off everywhere a client retries;
- a load test with hundreds of simulated agents is part of done.

It also takes Codex's review of the sequence and gap handling (Y09 F2, §7).

### 1. One Durable Object per agent, and a small fleet directory

This replaces r6 §1's and §5's "one Durable Object per fleet".

- **The agent's DO** (one per (fleet, agent)) holds everything on that agent's message path: its threads, the inbox seq and each thread's seq, the message and reply records, the dedupe keys (fleet, agent, id), the delivered high-water mark and ack cursor per host, the receipts, the turn state and the agent's own limits and counters. Every send, poll, ack, reply and R1 `covers` check touches only this DO. r6 already scopes all of these to one agent (the inbox seq is per (fleet, agent), a thread belongs to one agent, R1 checks the same thread and agent), so nothing on the message path crosses agents.
- **The fleet directory DO** (one per fleet) holds only what is fleet-wide and rare:
  - the claimed thread ids, so r3's `thread_conflict` still holds across agents, hosts and fleets: the page's send that creates a thread claims its id here first (one write per new thread, never per message), then writes into the agent's DO. A claim that the agent's DO never confirms (a crash between the two) is confirmed or released by the next send with that thread id, so a claim can't strand an id the person is using;
  - the per-host channel index (§2);
  - the fleet's budget counters that must be fleet-wide (§3).
- **The directory route** (`GET /api/fleet/v1/agents`) stays as r6 has it, read from the chain and grants (D1), not from any DO.
- **The thread list** (`GET /api/fleet/v1/agents/<agent>/threads`) is the agent's DO.
- **Grant checks** are unchanged: each DO checks host and agent through the Worker's grant lookup before it accepts a call, and again at answer time (r6 §4).
- **Rows:**
  - two agents' sends commit concurrently without waiting on each other (a row measures that agent B's send latency doesn't grow with agent A's load);
  - a new thread id already claimed by another agent, host or fleet: `thread_conflict`, as before;
  - a crash between the claim and the agent DO's write: the next send with that thread id confirms the claim and the thread is created once;
  - no route on the message path (send, poll, ack, reply, turn state) touches the directory DO except thread creation (a row counts DO calls per message).

### 2. One channel per host, not one long poll per agent

This replaces the per-agent long poll as the host's way to learn of new messages. N3's "every granted agent at once" form (reserved in r6) becomes the default.

- **The channel.** A host opens ONE WebSocket to its host channel DO (one per (fleet, host)), using Cloudflare's hibernation API, so an idle channel costs no DO duration. The upgrade request carries the host's `Sagebrush-Sig` and is checked like any host request (aud, window, signature, gen, nonce).
- **Hints only.** When an agent's DO commits a send, it notifies the host channel DO of that agent's host with `{agent, inbox_seq}`. The channel forwards it to the host as a hint frame. A hint carries no body, no envelope and no thread: only an agent id and a seq number.
- **The host pulls, as before.** On a hint, the host's supervisor pulls that agent's inbox with the r6 route (`GET /host/inbox?after=`, without `wait`), which is authenticated and grant-checked per request. So a hint grants nothing: a forged, stale or lost hint changes only when the host pulls, never what it receives.
- **Catch-up.** On every (re)connect, and every `catchup_interval` while connected, the host calls `POST /api/fleet/v1/host/inbox/heads` (N3's `/all` form): one call, answering the head inbox seq of every agent in its latest issued grant. The host pulls each agent whose head is past its cursor. So a hint lost in a disconnect or an eviction is found by the next catch-up, and the cursor, not the hint, decides what is delivered (r6 T7 holds).
- **Revocation.** The channel DO re-checks the host against the grant when it forwards a hint and at least every `channel_recheck_interval`, and closes the channel with the closed code (`host_revoked`, `not_granted`) when the host or all its agents have left the grant. A hint for an agent that left the grant isn't forwarded.
- **The per-agent long poll stays** (r6 §4, `wait` up to 25 s) for a host without a channel, a test, or a fallback, with the same rules. A host uses one or the other per agent, never both.
- **The page** keeps its per-thread long poll: a person has a few threads open, not hundreds.
- **Cost per message:** one agent-DO transaction, one DO-to-DO notify, one hint frame, one pull. None of these grows with the number of agents in the fleet or on the host.
- **Rows:**
  - a send reaches the host by hint and pull; with the channel down, the next catch-up finds it; a hint dropped on purpose (a test hook) is found by the catch-up;
  - a forged hint frame (a test client injects one) causes a pull that returns only the real records;
  - a host revoked while connected: its channel closes with `host_revoked`, and its next pull is refused;
  - `heads` answers every granted agent's head in one call, and no agent outside the latest issued grant;
  - a channel idle for 10 minutes accrues no DO duration (hibernation; checked on DEV, §6);
  - one host with 100 agents: one channel and one catch-up call, never 100 polls.

### 3. Limits from budgets, with documented defaults and ranges

This replaces r6 §5's and r7 §3's fixed values. Every limit is a deployment variable, validated at start as r6 §5 already requires (missing, not a positive integer, or out of its documented range refuses the routes' start; no guessed default). The defaults are the starting values; each range's ceiling comes from the measured budget (§6), not from a constant.

| Variable | Default | Range | Per |
|---|---|---|---|
| `sends_per_minute` | 60 | 1 to `sends_per_minute_max` | (fleet, agent) |
| `sends_per_day` (the agent's own setting, r7 §3) | 3,000 | 1 to `sends_per_day_max` | (fleet, agent) |
| `sends_per_day_max` | 100,000 | 1,000 to 1,000,000 | deployment |
| `unacked_per_agent` | 2,000 | 1 to 100,000 | (fleet, agent) |
| `wake_interval_ms` (r6's one wake per 30 s) | 30,000 | 0 to 3,600,000 | (fleet, agent) |
| `replies_per_day` (r7 §3: the host's replies) | = the agent's `sends_per_day` | as `sends_per_day` | (fleet, agent) |
| `host_requests_per_minute` | 120 + 60 × the host's granted agents | the formula's two terms each 1 to 10,000 | (fleet, host) |
| `fleet_storage_bytes` | 10 GiB | 1 GiB to the plan's DO storage limit | fleet |
| `catchup_interval_ms` | 60,000 | 5,000 to 600,000 | deployment |
| `channel_recheck_interval_ms` | 300,000 | 60,000 to 3,600,000 | deployment |

- `PUT /api/fleet/v1/agents/<agent>/limits {sends_per_day}` (r7 §3, r9's version rule) accepts 1 to `sends_per_day_max`, so a coordinator taking hundreds of agents' traffic isn't capped at 10,000.
- The per-host request budget grows with the host's number of granted agents, so a host with hundreds of agents isn't throttled by a per-host constant.
- The 64-per-page and 1 MiB poll bounds, the 64-per-record `covers` bound (r9), the 100-per-page thread list and the 64 KiB body stay: they're page and record sizes, not throughput limits.
- **Every refusal is clear.** Past any limit the answer is `limit` with `retry_ms` and the variable's name (`{reason: "limit", limit: "sends_per_day", retry_ms}`), so a person or host sees which budget it hit. A fleet past `fleet_storage_bytes` refuses new sends `limit` (`fleet_storage_bytes`) and never drops a stored record.
- **Rows:** each variable at its edges and outside its range (a table-driven row, as r6's); each refusal names its variable; `sends_per_day` at `sends_per_day_max` accepted, one more refused `bad_form`; a host with 300 granted agents gets 120 + 60 × 300 requests a minute.

### 4. Back-off and back-pressure on every client retry

r10 retries only `limit` (at `retry_ms`) and transport failures. r12 fixes how:
- **Full-jitter exponential back-off.** A retry waits a uniform random time in [0, min(cap, base × 2^attempt)], and never less than the `retry_ms` it was given. Defaults: base 1 s, cap 5 min (host configuration, validated at start). This holds for the host's record resends, its pulls, its catch-up calls and its channel reconnects, and for the page's sends.
- **No head-of-line blocking across agents.** The host keeps one resend queue per agent. A `limit` on one agent's queue delays only that queue.
- **Bounded concurrency.** At most `host_inflight` requests in flight per host (default 16, range 1 to 256), so a host with hundreds of agents waking at once doesn't open hundreds of connections.
- **The host-freeze lesson:** no retry loop without back-off, no logging of a full body or response per retry (one line with the closed code and the record id, as r10 has it).
- **Rows:**
  - 100 hosts refused `limit` together retry spread over the jitter window, never in one burst (a row measures the retry times' spread);
  - a `limit` on agent A's queue doesn't delay agent B's records on the same host;
  - a retry never comes earlier than its `retry_ms`;
  - the host never has more than `host_inflight` requests open.

### 5. Turns waiting for capacity

The host runs one turn at a time per agent (r6 §7). With hundreds of agents, the host's concurrent turns are bounded by its subscription pools' measured quota (the advisor, the host lane's), not by a constant.
- **A wake that can't start for capacity is queued**, oldest message first across the host's agents, and the host posts the turn state `queued` (a new value of r6's `POST /host/turn` `state`: `working | idle | queued`). The page shows "Waiting for capacity".
- **The message isn't acked while queued.** r7's ack-on-delivery applies when the message is handed to a turn or starts one, and a queued wake has done neither. So "seen" still means "the agent has it now".
- **No message is lost or refused for capacity.** It waits in the inbox, within `unacked_per_agent`.
- **Rows:**
  - with a pool quota of 10 concurrent turns and 300 agents woken at once: 10 run, 290 show `queued`, and all 300 run in turn, oldest first;
  - a queued message isn't acked until its turn takes it.

### 6. The load test (part of done)

The PR that builds the service includes `scripts/fleet-messages-load.mjs`, run against the real DO code:

1. **Miniflare (every CI run of the fleet Worker's suite, short; and a long form by hand):**
   - 500 simulated agents on 50 simulated hosts (10 each), each host with one channel;
   - simulated pages sending 1 message per agent per 10 s for 10 minutes, plus a coordinator agent receiving 600 a minute (within raised limits);
   - each host verifying nothing (a stub host), pulling on hints, acking and replying with a `turn_failed`-sized record;
   - failure injection: channels dropped and reconnected, hints dropped, `limit` storms, a DO evicted mid-send.
2. **DEV, once before the first PROD deploy:** the same with 500 agents and 50 hosts, from spot VMs in our own project.

**Recorded, with pass lines set from the first run and kept in the PR:**
- send-to-hint and send-to-pull latency, p50 and p99;
- DO CPU ms and storage bytes per message (DEV analytics), and DO calls per message;
- wakes per message;
- refusals by variable, and the retry-time spread under `limit` storms;
- no message lost (every send acked and answered exactly once), and every seq from 1 to `head` a live record or inside a deleted range (§7).

### 7. Sequences, deleted ranges and the retained boundary (Codex's Y09 F2)

r6 calls both seqs gap-free from 1 (§3), erases a deleted thread's bodies at once and its metadata (seqs included) after 30 days (D2), and keeps the inbox gap-free with one `deleted` placeholder per message (D2). Y09 F2: the placeholders' lifetime after the 30 days isn't stated. So an offline host at cursor 0, whose message 1 was deleted and aged out, followed by a live message 2, can't tell deleted history from a missed fetch. r12 settles it with one rule, compact ranges kept for the life of the inbox:

- **Deleted ranges, not placeholders.** Deleting a thread records its inbox seqs as ranges `{from, to}` in the agent's DO: one record per contiguous span, and adjacent spans merged. This replaces r6's per-message placeholders.
- **The ranges are kept for the life of the inbox, never aged out.** The 30-day tombstone ends the THREAD's metadata (ids, kinds, thread seqs; D2), never the inbox's ranges. A range costs a few bytes whatever its length, and deletions are a person's acts, so the count is bounded by what people do, not by message volume. The inbox therefore stays accounted for, seq by seq, for as long as it exists: every seq from 1 to `head` is a live record or lies inside a deleted range.
- **A poll answers a range as one item:** `{deleted: {from, to}}`, clipped to the poll's `after`. The host moves its cursor to `to`. A poll's 64-item page counts a range as one item, so a span of any length costs one item. A host must never expand a range into one mark per seq (Y09).
- **The retained boundary, stated.** Every poll and `heads` answer carries `head` (the last assigned inbox seq) and `floor`, the lowest seq the service can still answer. In r12 `floor` is always 1, because nothing on the inbox ages out. A future retention change would raise it, and then a poll with `after` < `floor` - 1 is answered `cursor_expired {floor, head}`, never silently from `floor`. The host then runs its documented restart: it takes `floor` - 1 as its cursor, records the expiry in its log with both numbers, and continues. So the answer always distinguishes "deleted" (a range), "expired" (`cursor_expired`) and "not yet" (`after` = `head`).
- **Caught up** is `after >= head`: two integers compared, never a scan.
- **Seqs are integers** in storage, on the wire (JSON numbers within 2^53, checked as safe integers) and in every comparison and sort. Never strings, and never 32-bit (Y09 F1's lesson).
- **The thread seq (the page's).** A live thread never loses a seq. A deleted thread answers its read with `thread_deleted {final_seq}`, before and after the 30 days alike, and never returns records with holes.
- **Rows (Codex's, from Y09):**
  - a host returning after the tombstone's expiry: at cursor 0, with message 1 deleted 31 days ago and a live message 2, the poll answers `{deleted: {from: 1, to: 1}}` then message 2, `floor` 1;
  - a completely empty retained load: an inbox whose every message was deleted answers its ranges and `head`, with no records, and the cursor reaches `head`;
  - a partial fetch: a deleted range of 10,000 seqs answers as ONE item, followed in the same 64-item page by the live records after it; `more` is set only when further items exist;
  - a new message after an empty load: the next poll from `head` returns exactly that message;
  - adjacent deletions merge into one range, and two non-adjacent ones stay two;
  - `cursor_expired`: with `floor` raised by a test hook, a poll below it answers `cursor_expired {floor, head}` and the host's restart takes `floor` - 1 (a host row), never a silent skip;
  - a cursor of 2^31, 2^32 and 2^53 - 1 is accepted and compared exactly, and 2^53 is refused `bad_form`;
  - a deleted thread's read answers `thread_deleted {final_seq}` before and after the 30 days.

### For the lanes

- **SEC:** the channel carries hints only and grants nothing (§2); the directory DO's thread claim keeps `thread_conflict` (§1); no new trust in the service.
- **TESTS:** the rows in §1 to §5, and the load test's recorded lines (§6).
- **Codex:** §7 (Y09 F2).
- **The host lane:** the channel client, the catch-up, the per-agent resend queues and back-off (§4), and queued wakes (§5) are yours.

---

## Agent messages (M7): r12.1, a delta on r12 (3d86cd79) for SEC's hold (C1-C3, N1, build notes N2-N8) and TESTS' hold (T1-T5 and the rows)

r12 stands except where this changes it. Two changes go beyond rows: §7's deleted ranges are replaced by a certified `through` (T5), and the agent DO's notify becomes durable (T4).

### C1. Thread ids are scoped to their fleet

- A thread's identity is (fleet, thread). Every route and every store is already scoped to one fleet (r7 §4: one account, no inter-account messaging), so two fleets can't see each other's threads, and a thread id in one fleet is unrelated to the same id in another.
- So `thread_conflict` is a per-fleet rule, held by that fleet's directory DO: an id already claimed in this fleet for another agent or host is refused. r12 §1's "across agents, hosts and fleets" becomes "across the fleet's agents and hosts".
- Nothing is global, so there's no global directory to cost.
- **Row (replacing r6 T2's cross-fleet case):** the same thread id used in two fleets makes two unrelated threads. Neither fleet's routes can read, reply into or delete the other's, and no route of either answers `thread_conflict` because of the other.

### C2. A claim is bound to its agent and never released

r12 §1's "confirmed or released by the next send" is withdrawn: release was where the race lived. Instead:
- **The claim is one conditional write** in the directory DO: `claim(thread, agent)` stores `thread -> agent` if the id is absent, and answers `ok` if it is absent or already held by the SAME agent, `thread_conflict` otherwise. The directory serializes it, so two claims for one id can't both succeed.
- **The agent's DO creates the thread only after its claim answered `ok`,** in its own transaction with the first message (r6 §5).
- **A claim is never released.** A crash between the claim and the agent DO's write leaves the id claimed for that agent and no thread. The next send to that same agent with that id (the page's retry of the same message, by its idempotent id, or any later send) is answered `ok` by the claim and creates the thread once. A send for ANY other agent or host with that id gets `thread_conflict`, before and after.
- **The cost:** an id that was claimed and never used stays reserved to its agent. Ids are 22-character random values chosen by the page, so a page that gets `thread_conflict` picks a new id, and nothing legitimate needs a released id.
- **Rows:**
  - two agents, A and B, sending a new thread with the same id at once: exactly one claim succeeds; the other's send is `thread_conflict` and stores nothing;
  - a crash injected after A's claim and before A's write: B's later send with that id is `thread_conflict`; A's retry creates the thread exactly once;
  - the same with the delay on B's side: a late write by the agent whose claim failed can't create the thread (its DO never got `ok`);
  - the same agent claiming an id it already holds: `ok`, and one thread.

### C3. The fleet's storage budget: leases held by the agents' DOs

- **Leases.** The directory DO holds the fleet's `fleet_storage_bytes` and the bytes leased out. An agent's DO stores records only against bytes it has leased: it asks the directory for a chunk of `lease_chunk_bytes` (default 16 MiB, range 1 MiB to 256 MiB) when its leased bytes would run out, and stores against it until it's used.
- **No overshoot.** The directory counts leased bytes as used, and never leases past `fleet_storage_bytes`. So the bytes stored fleet-wide never exceed it. The cost of leasing is slack, never overshoot: at most one chunk per agent can be leased and unused, so the unusable part of the budget is at most (the fleet's agents) x `lease_chunk_bytes`.
- **Returns.** An agent's DO returns whole chunks when its unused leased bytes pass 2 x `lease_chunk_bytes` (after a thread's delete erases its bodies, D2).
- **Fail closed.** A send that needs a lease the directory doesn't grant (the budget is spent, or the directory doesn't answer) is refused `limit` (`fleet_storage_bytes`) with `retry_ms`. It is never stored unbudgeted.
- **r12 §1's row** becomes: no route on the message path touches the directory DO except thread creation (one claim per new thread) and a lease (at most one per `lease_chunk_bytes` stored by that agent). A row counts the directory calls per message over 10,000 sends.
- **What counts:** a record's stored bytes (envelope, sealed body, metadata).
- **Only the page's sends are refused for storage (TESTS 2).** A send leases its own bytes plus an answer reserve of `answer_reserve_bytes` (default 66 KiB: one sealed reply of the largest body, with its envelope). The host's replies, covered and turn_failed records, acks, receipts and turn states draw on the agent's reserves and are never refused for storage, so a full budget can't wedge an agent's answers. Records a turn posts beyond its reserves are still stored; that overdraw is bounded by r9's records per turn.
- **A storage refusal has no `retry_ms`:** it's `{reason: "limit", limit: "fleet_storage_bytes", retry_ms: null}`, since waiting doesn't free storage. Deleting threads or raising the budget does.
- **Rows:**
  - with `fleet_storage_bytes` = 4 chunks and 8 agents each sending: the stored total never passes the budget; the sends past it are refused `limit (fleet_storage_bytes)`;
  - the directory made unreachable (a test hook): an agent with leased bytes left keeps accepting sends until they're used, then refuses `limit`, never stores unbudgeted;
  - deleting a thread returns whole chunks, and another agent's next lease succeeds;
  - an agent DO evicted with a lease outstanding keeps it (the lease is durable in both DOs), so nothing is double-counted or lost;
  - with the budget spent: a page send is refused `limit (fleet_storage_bytes)` with `retry_ms: null`, and a host reply, an ack and a turn state for an earlier send are all still accepted.

### N1. The per-host request budget is bounded

- A host's granted agents are bounded by the grant: at most 4,096 agents per host (core grant records, `MAX_AGENTS` in lib/fleet/host/grant.mjs and host-records.mjs). So `host_requests_per_minute` is at most 120 + 60 x 4,096 = 245,880 a minute with the defaults, and the formula's two terms keep their ranges (1 to 10,000 each).
- A fleet's agents are bounded by its hosts' grants. `fleet_agents_max` (default 10,000, range 1 to 1,000,000) bounds them across the fleet, enforced when a grant names a new agent: the grant intake refuses `limit (fleet_agents_max)`, and the directory DO's lease slack (C3) is bounded by it.
- **Rows:** a host granted 4,096 agents gets 245,880 a minute; a grant that would pass `fleet_agents_max` is refused with that name.

### Build conditions from SEC's notes (N2-N8)

These hold in the PR that builds the service and the host, each with a row there.
- **N2:** the channel's host identity and gen come only from the server-side attachment set at the authenticated upgrade, never from anything the client sends, and are read back from that attachment after hibernation.
- **N3:** frames from the client are ignored, a ping aside, and are bounded in size: one past `channel_frame_max` (default 1 KiB) closes the socket.
- **N4:** a new authenticated connection for the same (fleet, host) replaces the older one, which closes with `replaced`, so a host has at most one socket in its DO.
- **N5:** a grant change or a gen bump closes the channel at once, through the directory DO's per-host channel index. `channel_recheck_interval` stays as the backstop. Until then a revoked host learns at most agent ids and seq numbers, since each forward is grant-checked.
- **N6, N7:** superseded by T5: no deleted ranges are stored, so nothing outlives the thread's metadata, and deletions can't grow a range count. The delete route still takes the page's session only, never a host's signature (N7's rule stands).
- **N8 (as T5 has it):** the host checks every page: safe integers; each record's seq > `after` and <= `through`, increasing; `through` <= `head`. Otherwise it refuses the page as malformed and keeps its cursor. It never moves its cursor past `head`.

### T1. Back-off: the jitter is added to `retry_ms`, never clamped to it

TESTS: clamping a uniform draw up to `retry_ms` makes refused hosts retry together at exactly `retry_ms`. r12 §4's rule becomes:
- a retry after `limit` waits `retry_ms` + uniform[0, max(`retry_ms`, min(cap, base x 2^attempt))]; a transport failure waits uniform[0, min(cap, base x 2^attempt)] (full jitter);
- base 1 s, cap 5 min; the attempt counter resets on a success;
- answers that aren't `limit` or transport failures (`bad_form`, `not_granted`, r10's permanent list) are never retried;
- the host's clock and random source are injectable, so the rows run on a fake clock with a seeded random source in CI.
- **Rows:**
  - 100 hosts refused `limit` with the same `retry_ms` = 10 s: their retries fall in [10 s, 20 s], no 1 s window holds more than 25% of them, and their spread is at least 8 s (seeded, so the numbers are exact in CI);
  - every retry is at or after its `retry_ms`;
  - a success resets the attempt counter (the next failure waits base, not the old exponent);
  - `bad_form` and `not_granted` are never retried;
  - a reconnect storm: 50 channels dropped at once reconnect spread by the jitter, no 1 s window holding more than 25%.
- **Fairness under `host_inflight`:** the host takes records from its agents' queues round-robin, so with agent A holding 1,000 queued records and B one, B's record goes within the next `host_inflight` sends. Row: exactly that.

### T2. The fleet storage budget

Answered by C3 (leases, no overshoot, slack bounded) and its additions above: only page sends are refused, with `retry_ms: null`.

### T3. The load test's absolute gates

r12 §6's "pass lines set from the first run" stays only for the performance lines; the correctness lines are absolute now:
- **CI (Miniflare), the short form,** in the fleet Worker's suite: 100 agents on 10 hosts, 60 s, 1 send per agent per 2 s, with every injected failure of §6 (channels dropped, hints dropped, notifies failed, a DO evicted mid-send, a `limit` storm). It asserts:
  - every (fleet, agent, id) sent is delivered to its host and answered exactly once: none lost, none duplicated;
  - no refusal at this load within the default limits except the storm's, and each refusal names its variable;
  - the DO-call counts per message of §1 (structural, not timing).
  Miniflare runs every DO in one process, so CI asserts no latency or CPU line.
- **The long form** (500 agents, 50 hosts, 10 minutes, the coordinator at 600 a minute) runs by hand and nightly on Miniflare, with the same correctness gates.
- **DEV, once before the first PROD deploy,** with the long form's load from spot VMs in our own project:
  - correctness: the same gates;
  - latency: send-to-pull p50 <= 500 ms and p99 <= 3 s; recorded with DO CPU ms and storage bytes per message, and wakes per message;
  - the script refuses any base URL but DEV's, in a test account of our own; the test fleet and its DOs' storage are deleted after the run (a DEV-only test-purge route, absent from PROD's build); a row checks the purge leaves nothing.

### T4. `heads` reads the agent DOs, and a notify can't be lost

- **The notify is durable.** An agent DO's send transaction also marks "notify pending" for that host. The DO's alarm sends the notify and retries it with back-off (T1) until the host channel DO accepts it, then clears the mark. So a failed notify delays a hint, never loses it, and the send commits and answers ok whatever the notify does.
- **`heads` comes from the agent DOs,** not from the channel's hints: the Worker asks each agent DO in the host's latest issued grant for its head, in parallel with bounded concurrency (`heads_concurrency`, default 32).
- **Partial answers:** an agent DO that doesn't answer within `heads_timeout_ms` (default 2 s) is listed `{agent, head: null, unavailable: true}`, and the host retries that agent with back-off. The rest of the answer stands.
- **Paging:** at most 256 agents per answer, in agent-id order, with `next` naming the first agent of the next page.
- **Cost:** a catch-up is one read per granted agent, every `catchup_interval_ms`, whose default becomes 300,000 (5 min): the durable notify makes catch-up the backstop, not the path.
- **The host the notify goes to** comes from the grant lookup the agent DO already makes for every send (r6 §2: the DO checks host and agent through the Worker's grant lookup), never from the directory.
- **Rows:**
  - an agent DO's notify fails (injected): the send answers ok, and the hint arrives after the retry; with the notify failing until the next catch-up, the catch-up finds the message;
  - `heads` with one agent DO evicted or slow: that agent is listed unavailable, the others answered; the host's retry gets it;
  - a host with 600 granted agents: `heads` answers in 3 pages (256, 256, 88);
  - re-grant: an agent moved from host H1 to H2: hints go to H2, H1 gets none, and H1's channel closes if H1 has no agents left.

### T5. No deleted ranges: a page certifies its gaps with `through`

TESTS: a thread deleted while interleaved with a live thread leaves one range per message, so ranges grow with messages after all. r12 §7's ranges are replaced:
- **The invariant:** inbox seqs are assigned in the send's transaction (r6 §5), and only a thread's delete removes records. So any seq at or below `head` that has no live record has been deleted. The service stores no record of deletions in the inbox; a deleted thread's records are simply gone from the agent's inbox index.
- **A poll** answers up to 64 live records with seq > `after`, oldest first, and `through`:
  - when more live records exist: `through` is the seq of the last record returned, and `more: true`;
  - otherwise: `through` = `head`, and `more: false`.
  The service certifies that every seq in (`after`, `through`] not returned is deleted. The host sets its cursor to `through`. A page costs one indexed range read whatever was deleted, so interleaved deletions cost nothing.
- **`floor` and `cursor_expired`** stay as r12 §7 has them (`floor` is 1 in r12.1).
- **`after` > `head`** is refused `bad_form` (`cursor_ahead`), never treated as caught up.
- **Cursors** are safe integers: `after` = 0 is the start; negative, fractional, string and 2^53 values are `bad_form`.
- **Rows** (Codex's Y09 rows restated, then TESTS'):
  - a host back after the tombstone's expiry, at cursor 0, with message 1 deleted and a live message 2: the poll answers [message 2] with `through` 2;
  - an inbox whose every message was deleted: no records, `through` = `head`, and the cursor reaches `head`;
  - 10,000 deleted seqs, then 5 live ones: one page with the 5 records and `through` = `head`;
  - TESTS' interleaved deletion: a thread of 10,000 messages alternating with a live thread's 10,000, the first deleted: the live thread's records come in 157 pages of 64 (the same as with no deletion), and nothing is stored for the deletion;
  - a new message after an empty load: the next poll returns exactly it;
  - `more` and `through` when the page's last record is the last live record: `more: false`, `through` = `head`;
  - a deletion between a hint and its pull: the pull returns no record for it, and `through` covers its seq;
  - the `floor` edge with a test hook: `after` = `floor` - 1 accepted, `floor` - 2 is `cursor_expired`;
  - `after` > `head`: `bad_form`; `after` = 0 accepted; -1, 1.5, "1" and 2^53: `bad_form`;
  - the host refuses a page whose record seq is <= `after` or > `through`, or whose `through` > `head` (N8).

### The rows TESTS listed, by section

**§1:**
- C2's claim rows (above) cover A's crashed claim and then B's send (B gets `thread_conflict`), and two pages creating one new id on two agents at once (exactly one wins);
- "B's latency doesn't grow" is restated as structural: B's send makes no call to A's DO or to any shared DO except C2's claim and C3's lease (counted in CI); the latency form is a DEV line (T3);
- two fleets with the same agent id get separate DOs (the DO name is (fleet, agent));
- r6's one-DO-per-fleet layout was never deployed (r6 open item 4: the fleet Worker isn't on DEV), so there's nothing to migrate.

**§2:**
- a burst of 100 sends to one agent: the host coalesces its pulls (a pull answers up to 64, so at most 2 pulls plus the one in flight) and never passes `host_requests_per_minute`;
- a stale hint (seq <= the cursor) causes no pull;
- a hint for an agent that left the grant isn't forwarded;
- channel or long poll, never both: while a host has an open channel, its long polls (`wait` > 0) are refused `bad_form` (`channel_open`); the long-poll route checks the directory's channel index, which is off the channel path. Row: a host with a channel open sends a long poll and is refused;
- the hibernation row is restated: an idle channel's DO costs at most one wake per `channel_recheck_interval_ms`.

**§3:**
- `sends_per_minute_max` joins the table: default 600, range 1 to 10,000;
- the Default column is the shipped configuration's value; a deployment missing a variable still refuses its start (r6 §5), so the default is never guessed in code;
- a day is a UTC day (r8), with a row on each side of 00:00 UTC;
- `wake_interval_ms` = 0: no wake limit, with its own row;
- the host formula's granted-agent count is the one at the start of the current minute's window;
- `replies_per_day` follows the agent's `sends_per_day` as it is at each check, so a mid-day change applies to the next reply;
- `unacked_per_agent` full: a send is refused `limit (unacked_per_agent)`, and one ack frees exactly one.

**§5:**
- "oldest first" is by the service's `sent_ms`, ties broken by (agent id, inbox seq);
- the pool quota is the advisor's measured concurrent-turn capacity per subscription profile (the host lane's setting; the row sets it to 10 through the host's configuration);
- a queued wake whose agent is revoked, or whose message's thread is deleted, while queued: dropped from the queue, never acked, never run;
- a host restart with 290 queued: the queue is rebuilt from the unacked inbox in the same order.

---

## Agent messages (M7): r12.2, a delta on r12.1 (c7db3274) for TESTS' hold on C3 and SEC's build conditions (B1, N9-N13)

r12 and r12.1 stand except where this changes them.

### L1. Leases start small and grow with use (TESTS 1)

r12.1 C3's fixed 16 MiB chunk lets a few hundred barely-used agents lease the whole budget. Leases now start small and double:
- An agent DO's first lease is `lease_min_bytes` (default 64 KiB, range 4 KiB to 1 MiB). Each later lease is twice the last one the DO took, up to `lease_chunk_bytes` (default 16 MiB).
- **Never more than a fair share when the budget runs low:** a lease is at most max(`lease_min_bytes`, unleased / 64), where unleased is `fleet_storage_bytes` minus everything leased. So the last bytes are handed out in small pieces, never to one agent.
- **Recall:** when unleased falls below 10% of `fleet_storage_bytes`, the directory asks the agent DOs holding more than 2 x `lease_min_bytes` unused to return the excess, keeping `lease_min_bytes` each. An agent DO returns at its next send, or at its alarm within `lease_recall_ms` (default 60,000).
- **The slack bound becomes** at most (the fleet's agents) x `lease_min_bytes` once a recall has run: 625 MiB at `fleet_agents_max` (10,000) with the defaults. Before a recall it is bounded by the 10% threshold.
- **Idempotent (SEC N10):** a lease request carries a lease id the agent DO chose, and a return carries the ids it returns. A retried request whose first answer was lost leases once; a retried return frees once.
- **Rows:**
  - with the default budget, 1,000 agents each send one message: none is refused, and the leased total is 1,000 x 64 KiB plus what the sends used;
  - r12.1's row (`fleet_storage_bytes` = 4 chunks, 8 agents each sending) stands;
  - the budget nearly used: a recall runs, the holders return their excess, and the last bytes go to agents in pieces of at most unleased / 64, so the last send that fits is accepted;
  - a lease request retried after its answer is lost: one lease; a return retried: freed once.

### L2. Answers never overdraw: the reserve covers every record (TESTS 2, SEC N9)

r12.1's sentence "records a turn posts beyond its reserves are still stored; that overdraw is bounded by r9's records per turn" is withdrawn. Its case can't arise:
- Every answer record (`reply`, `covered`, `turn_failed`, `refused`) covers one or more messages that were delivered from page sends (R1). Each page send leased `answer_reserve_bytes`, at least the largest record: a sealed reply of the largest body with its envelope.
- Each message is in exactly one record's `covers` (r9 H1, r10 X1; under r11's `answer_lost`, the earlier `covered` records keep their messages, and the `answer_lost` record covers only the last record's). Per thread, a turn's records are at most its messages there.
- So a turn's records never need more than the reserves of the messages they cover, and the stored total never passes `fleet_storage_bytes`: **no overshoot and no overdraw.**
- Acks, receipts and turn states overwrite one row per (agent, host). They grow nothing.
- **A reserve is released** once its message's record is stored (the unused part returns to the agent DO's leased bytes), or when the message's thread is deleted.
- **Rows:**
  - with the budget spent, a turn covering 130 messages across three threads posts its records, all stored, and the stored total stays at or below `fleet_storage_bytes`;
  - a reserve returns once its message is answered, and once its thread is deleted;
  - an unanswered message's reserve is held until it's answered or its thread is deleted (never silently freed).

### L3. The storage refusal, in one form (SEC N11)

- The budget spent: `{reason: "limit", limit: "fleet_storage_bytes", retry_ms: null}`.
- The directory not answering a lease (transient): `{reason: "limit", limit: "fleet_storage_bytes", unavailable: true, retry_ms}`. The page retries it with T1's back-off.
- r12.1 C3's "with `retry_ms`" is read as this second form.

### L4. `heads` is weighted by the agents it reads (SEC B1)

- A `heads` page counts against `host_requests_per_minute` as one request per agent it reads, not one per page.
- A host also gets at most `heads_per_minute` pages (default 4, range 1 to 60) beyond one per channel (re)connect, refused `limit (heads_per_minute)`.
- **Row:** a host calling `heads` in a loop is refused `limit (heads_per_minute)`, and its agent-DO reads stay within both budgets.

### L5. Notifies: coalesced, and accepted for channel-less hosts (TESTS, T4)

- **Coalesced:** an agent DO keeps one "notify pending" mark per host, holding the latest seq. 100 sends before the alarm fires make one notify with the latest seq.
- **A host without a channel:** the channel DO accepts the notify and drops it when the host has no open socket. The mark clears, so it never alarms forever. A long-poll host learns of the message from its poll, as r6 has it.
- **Rows:**
  - 100 sends before the alarm: one pending mark and one notify, carrying the latest seq;
  - a notify for a long-poll host: accepted, dropped, and the mark clears; the next long poll delivers the message.

### L6. `through` when the 1 MiB bound cuts a page (TESTS, T5)

T5's rule is restated in full. A poll stops at 64 records or 1 MiB, whichever comes first:
- if it stopped with live records remaining: `through` is the seq of the last record returned, and `more: true`;
- if no live record remains after the last returned: `through` = `head`, and `more: false`.
- **Row:** 20 records of 64 KiB after the cursor: the page returns as many as fit in 1 MiB, with `through` = the last returned and `more: true`, never `head`.

### L7. Channel or long poll: the check reads the host's channel DO (TESTS, SEC N13)

- The long-poll route's `channel_open` check reads the host's channel DO, not the directory. So §1's directory-call row is unchanged, and the check is one call per long poll to that host's own DO.
- **A channel opening while a long poll waits:** the waiting poll still answers, at its next message or at its `wait`'s end. Long polls after the open are refused `bad_form (channel_open)`. A message delivered by both paths in that overlap is processed once: the host dedupes by id (r6 §4).
- **Row:** a channel opens while a long poll waits: that poll answers normally, the next long poll is refused `channel_open`, and a message delivered both ways runs one turn and is answered once.

### L8. Back-off for long `retry_ms` (TESTS, T1)

T1's wait becomes `retry_ms` + uniform[0, min(cap, max(`retry_ms`, base x 2^attempt))], so the added jitter is never more than `cap` (5 min).
- For `retry_ms` = 10 s it's still [10 s, 20 s], so T1's rows stand.
- **Row:** `retry_ms` = 86,400,000 (a day's cap): the retry comes between one day and one day plus 5 minutes.

### L9. The DEV-only purge route is absent from PROD's build (SEC N12, TESTS)

- The test-purge route is compiled only into the DEV build (a build-time flag, absent from PROD's configuration).
- **Row:** the BUILT PROD bundle is checked for the route's path and handler and must not contain either. This checks the artifact, not the source.

---

## Agent messages (M7): r12.3, a delta on r12.2 (6e3eba76) for Codex's hold on r12.1 (F1-F3) and SEC's L2a-L2c on r12.2

r12 to r12.2 stand except where this changes them. Codex found T5's `through` invariant sound under a snapshot rule (2,000 generated histories), and set three conditions. SEC cleared r12.2, with three additions to L2's argument and two notes.

### F1. One poll, one snapshot

- **The rule:** a poll's `head`, its live-record query, `more`, `through` and the delivered high-water mark it writes (r6 U4) are all read and written in ONE storage transaction of the agent's DO. Nothing that commits a send can interleave with them.
- **Why:** with them read separately, an empty query, then a send committing, then a newer `head` would answer `through` = the new head and certify the new live record as deleted.
- **The host checks** (adding to N8): `after` <= `through` <= `head`, and every record's seq lies in (`after`, `through`]. Otherwise the page is malformed: the host refuses it and keeps its cursor.
- **Rows:**
  - a send committing while a poll is being answered (a test hook between the query and the answer): either the record is in the page, or `through` stops below its seq; it is never certified deleted;
  - Codex's generated histories (sends, deletes and polls interleaved) as a property row: no live record ever lies at or below a `through` it wasn't returned with;
  - a page with `through` < `after`: refused by the host, and the cursor is kept.

### F2. A notify clears only its own mark

- r12.1 T4's pending mark per host holds the latest seq it must announce (r12.2 L5's coalescing).
- **A notify carries the mark's seq.** When it completes, the agent DO clears the mark only if the mark still holds that same seq. A compare-and-clear in one transaction.
- So an earlier notify finishing after a newer send was marked leaves the newer mark in place, and the alarm sends it.
- **Rows:**
  - notify n in flight, a send marks n+1, then n completes: the mark stays at n+1 and its notify follows;
  - Codex's 2,000 schedules (sends, notify starts and completions, alarms) as a property row: every committed send's seq is announced by some notify, or covered by a later catch-up;
  - a coalesced burst (r12.2 L5): one notify, then the mark clears.

### F3. Reconnects spread over a window wide enough for the gate

- r12.1 T1's first transport retry draws from [0, 1 s], so 50 channels dropped together reconnect within one second, against T1's own spread row.
- **Channel reconnects** use their own base, `reconnect_base_ms` (default 10,000, range 1,000 to 60,000): the first reconnect waits uniform[0, `reconnect_base_ms`], then doubles to `cap` as T1 has it. Other transport retries keep base 1 s.
- **The row is restated:** 50 channels dropped at once (seeded, fake clock) reconnect over [0, 10 s], no 1-second window holding more than 25% of them, and the spread is at least 8 s.
- The `heads_per_minute` rule (r12.2 L4) allows one `heads` per reconnect, so the spread reconnects don't refuse each other's catch-ups.

### L2a. `answer_lost` has its own reserve

r11's `answer_lost` record covers messages whose earlier `covered` record was already stored, and whose reserves r12.2 L2 then released. So without a reserve of its own, `answer_lost` would be stored on unbudgeted bytes.
- **The rule:** when the service stores a `covered` record with `answer` (r10 X1, a split answer naming another thread's reply), it keeps `answer_lost_reserve_bytes` from that record's released reserve. That's the size of a bodyless `turn_failed` record, fixed (default 2 KiB, range 1 KiB to 8 KiB).
- It's held until the named answering thread's outcome is stored (after which `answer_lost` can't arise), or until either thread is deleted. Then it's released.
- So `answer_lost` records are stored on reserved bytes, and r12.2 L2's "no overshoot and no overdraw" holds as written.
- **Row:** with the budget spent, a split turn whose answering thread is deleted before its reply posts: the other thread's `answer_lost` is stored, and the stored total stays at or below `fleet_storage_bytes`.

### L2b. The service enforces what L2's argument assumes

L2 holds for a misbehaving host only because the service refuses records that break it:
- an answer record whose `covers` is empty, or names a message already covered by a stored record, is refused `bad_covers`. The one exception is `answer_lost`, which covers its thread's last record's messages, as L2a has it;
- a record larger than `answer_reserve_bytes` is refused `bad_form`.
- **Rows:** a record covering an already-covered message, refused `bad_covers` (except `answer_lost`); an empty `covers`, refused; a record one byte past `answer_reserve_bytes`, refused.

### L2c. The reserve is checked at start

- A deployment whose `answer_reserve_bytes` is below the largest record (a sealed 64 KiB body, its 16-byte tag, the 12-byte nonce and the envelope at its schema's maximum) refuses the routes' start, as r6 §5's other range checks do. One lower setting would otherwise break L2 silently.
- **Row:** `answer_reserve_bytes` one byte below the largest record refuses start, naming the variable; exactly at it starts.

### Notes from SEC on r12.2

- **Leases are keyed by (agent DO, lease id).** The directory accepts a return only from the DO that holds the lease. Row: a return naming another DO's lease id is refused and frees nothing.
- **Where an idle agent's budget goes:** each unanswered page send holds its answer reserve (about 66 KiB) until it's answered or its thread deleted. So an offline or silent agent uses the budget at about 66 KiB per send, within its `sends_per_day`. That is budgeted and fails closed (page sends are refused `limit (fleet_storage_bytes)`). The Agents page shows the reserved bytes per agent, so the person can see where the budget went.

---

## Agent messages (M7): r12.4, a delta on r12.3 (1eef54be) for TESTS' hold on r12.2/r12.3 (lease sizes), SEC's A1 and the offline-agents ruling

r12 to r12.3 stand except where this changes them.

### A1 (SEC on r12.3). `answer_lost` only against its held reserve

r12.3 L2b's exception is tightened:
- `answer_lost` is accepted only against a held `answer_lost` reserve (r12.3 L2a), and it consumes that reserve. So it is accepted at most once per covered-with-answer record, and only while that record's answering thread has no stored outcome.
- A second `answer_lost` for the same record is refused `bad_covers`. So is one with no held reserve: the answering thread's outcome is already stored, or the record was never a split answer.
- **Row:** with the budget spent, one `answer_lost` is stored; a second for the same record is refused `bad_covers`; the stored total stays at or below `fleet_storage_bytes`.

### E1. A lease is at least what the send needs (TESTS)

One page send needs its own record (up to a sealed 64 KiB body and its envelope) plus `answer_reserve_bytes`: about 130 KiB, more than r12.2 L1's first lease of 64 KiB.
- **A lease's size is** min(unleased, max(need, min(next doubling, max(`lease_min_bytes`, unleased / 64)))), where need is the requesting send's bytes plus its answer reserve, less what the agent DO still holds leased.
- So one lease always covers the send that asked for it (if the budget can). The doubling and the fair-share cap shape only what's leased beyond that.
- If unleased is less than need, the send is refused `limit (fleet_storage_bytes)`, `retry_ms: null`.
- **Rows:**
  - an agent's first send with the largest body, `lease_min_bytes` at its default: one lease, accepted;
  - near exhaustion, with unleased = exactly one send's need: that send is accepted, and the next refused `limit (fleet_storage_bytes)`;
  - with unleased below 8.3 MiB (where unleased / 64 is below one send's need): sends that fit are still accepted, one lease each.

### E2. The slack stays a small share of the budget (TESTS)

- **Idle agents give back everything.** A recall (r12.2 L1) also takes the whole lease of any agent DO with no send for `lease_idle_ms` (default 3,600,000), except bytes already holding records and reserves. An idle agent then holds no free leased bytes, so the slack is (the agents active in the last hour) x `lease_min_bytes`, not every agent's.
- **A start check ties the three variables:** `fleet_agents_max` x `lease_min_bytes` must be at most 10% of `fleet_storage_bytes`. Otherwise the routes refuse to start, naming the three. With the defaults, 10,000 x 64 KiB = 625 MiB ≤ 1 GiB, which is 10% of 10 GiB. At `fleet_storage_bytes`' floor (1 GiB) the check forces `fleet_agents_max` down to 1,638 or `lease_min_bytes` down.
- **Rows:**
  - the start check at its edge: exactly 10% starts, one `lease_min_bytes` more refuses, naming all three;
  - an agent idle past `lease_idle_ms` during a recall returns all its free leased bytes and keeps its stored records and reserves.

### E3. Offline agents can't take the fleet's messaging down (the ruling)

TESTS: an unanswered send holds its reserve, so about 78 agents whose hosts are offline (each up to `unacked_per_agent` x ~66 KiB, about 132 MiB) could exhaust a 10 GiB budget. Every online agent's sends would then be refused. That fails closed, but at hundreds of agents one person's offline hosts would stop the fleet. So:
- **An agent is offline** when its host hasn't polled, pulled or held a channel for `offline_after_ms` (default 600,000, 10 minutes).
- **The offline pool:** the bytes held for undelivered sends to offline agents (their records and reserves) count against `offline_pool_bytes` (default 25% of `fleet_storage_bytes`, range 5% to 100%). A send to an offline agent that would pass it is refused `limit (offline_pool_bytes)`, `retry_ms: null`.
- **Online agents keep the rest.** At least `fleet_storage_bytes` - `offline_pool_bytes` always stays available to agents whose hosts are online.
- **When a host comes back,** its agents are online again, and their held bytes leave the offline pool as their messages are delivered.
- **The Agents page** shows an offline agent as offline, the bytes its unanswered messages hold, and, when the pool is full, "Messages to offline agents are paused until their hosts reconnect."
- **Rows:**
  - 100 agents whose hosts are offline receive sends until the pool is full: those sends are refused `limit (offline_pool_bytes)`; an online agent's sends are still accepted, and its stored total stays within the budget;
  - an offline agent's host reconnects: its messages are delivered, and the pool frees as they are;
  - an agent goes offline with messages held: they move into the pool's count, and a send that would pass the pool is refused.

### E4. The property rows, in checkable form (TESTS)

- **r12.3 F2:** each generated schedule includes catch-up calls and always ends with a final catch-up. The invariant: after that final catch-up, for every agent, the host's cursor reaches the agent DO's `head`, and every committed seq was either named by a notify the host received or returned by a pull the catch-up caused. A dropped notify counts as covered only if a catch-up in that schedule actually ran after it.
- **r12.3 F1:** the test hook runs INSIDE the poll's storage transaction. A send arriving during it waits behind the transaction (the DO's input gate) and commits after the answer, so the row checks that the send's record is in the next poll, never certified deleted by this one. A hook outside the transaction couldn't make the row fail, so it isn't one.

---

## Agent messages (M7): r12.5, a delta on r12.4 (eaacf988): E3 replaced (SEC's E3a/E3b, TESTS' E3 condition)

r12 to r12.4 stand except that r12.4 E3 (the offline pool) is replaced by this.

**Why:** E3 keyed the pool on connectivity, but the cost comes from unanswered messages.
- A host that stays connected and never answers (a bug, or a compromised host) bypassed it (SEC E3a).
- Bytes stored while an agent was answering moved into the pool when it went offline, possibly far past the pool's limit in one step. So E3's guarantee was false as worded (SEC E3b, TESTS).

A fleet is one account, so the case to bound is one granted host misbehaving and stalling the account's messaging.

### E3'. Held bytes, bounded per agent and per host, with stale bytes pooled by age

**Terms.**
- A message's **held bytes** are its record plus its answer reserve, from its send until a record covering it is stored (or its thread is deleted).
- A message is **stale** once it has been held longer than `stale_after_ms` (default 600,000, range 60,000 to 86,400,000), whatever its host's connectivity: offline, connected but silent, or slow. Its held bytes are then **stale bytes**.

**Four bounds, checked for every page send to agent X, in this order:**
1. **Per agent:** X's held bytes + need <= `agent_held_bytes_max` (default 132 MiB, which is `unacked_per_agent` x `answer_reserve_bytes`, so no stricter than r12's unacked bound by default; range 1 MiB to `fleet_storage_bytes`). Checked in X's DO, with nothing shared. Refused `limit (agent_held_bytes_max)`, `retry_ms: null`.
2. **Per host:** the held bytes of all agents on X's host + need <= `host_held_bytes_max` (default 10% of `fleet_storage_bytes`, range 1% to 100%).
   - It's enforced by held-credit leases from the host's channel DO, the same pattern as r12.2 L1 and r12.4 E1: an agent DO leases held credit in chunks (at least the send's need), so a send doesn't call the channel DO unless its agent's credit runs out.
   - The slack is at most (the host's active agents) x `lease_min_bytes`, and leases are idempotent by lease id.
   - Refused `limit (host_held_bytes_max)`, `retry_ms: null`.
3. **The stale pool:** if X has ANY stale message, the fleet's stale bytes + need <= `stale_pool_bytes` (default 25% of `fleet_storage_bytes`, range 5% to 100%).
   - This needs the directory DO, which keeps the stale total: one call, only on this path. A send to an agent with no stale message skips it.
   - Refused `limit (stale_pool_bytes)`, `retry_ms: null`.
4. **The fleet budget:** the lease of r12.4 E1, unchanged.

**The stale total.** Each agent DO reports its staleness transitions (messages becoming stale, stale messages answered or deleted) to the directory DO from its alarm, batched: at most one call per agent per `stale_report_ms` (default 60,000). So the total lags by at most that interval. The lag only delays a refusal; it never lets the stored total pass the budget, because bound 4 holds every byte by lease.

**The guarantee, stated as it holds:**
- The stored total never passes `fleet_storage_bytes` (bound 4).
- With one misbehaving host H (offline, connected and silent, or slow), the agents on every other host can always use at least `fleet_storage_bytes` - `stale_pool_bytes` - `host_held_bytes_max`. H's held bytes, fresh or stale, never exceed `host_held_bytes_max` (bound 2), and the stale bytes of everyone else's admitted sends are capped by `stale_pool_bytes` for new admissions (bound 3).
- At the defaults (10 GiB budget, 25% pool, 10% per host): at least 6.5 GiB stays usable by the other hosts' answering agents.
- **Aging overflow is bounded, not denied (TESTS, SEC E3b):** bytes admitted fresh can age into the stale total after admission and take it past `stale_pool_bytes`. The excess is at most the fresh held bytes of the hosts that stop answering, which is at most `host_held_bytes_max` per such host. While the stale total is over `stale_pool_bytes`, every send to an agent with a stale message is refused (bound 3), and the over-full pool is shown.

**The Agents page** shows each agent as "answering", "not answering" (stale messages, host connected) or "offline", with its held bytes. Each host shows its held bytes against `host_held_bytes_max`, and the fleet shows the stale total against `stale_pool_bytes`, marked over-full when it is.

**§1's directory-call row** gains two entries: the stale reports (at most one per agent per `stale_report_ms`), and bound 3's check (only for sends to an agent with a stale message). Neither is on the path of a send to an answering agent.

**§3's table** gains `stale_after_ms`, `agent_held_bytes_max`, `host_held_bytes_max`, `stale_pool_bytes` and `stale_report_ms`, with the defaults and ranges above. r12.4 E3's `offline_after_ms` and `offline_pool_bytes` are withdrawn.

**Rows:**
- **SEC E3a:** a connected-but-silent host's 100 agents receive sends; their held bytes reach `host_held_bytes_max` and those sends are refused `limit (host_held_bytes_max)`; once their messages are stale, sends to them past the stale pool are refused `limit (stale_pool_bytes)`; an answering agent on another host keeps sending, accepted;
- **SEC E3b / TESTS:** agents holding bytes go silent and age into the stale total past `stale_pool_bytes`: the pool shows over-full, every send to an agent with a stale message is refused, the stored total stays within the budget, and the other hosts' answering agents can still use the stated bound;
- `agent_held_bytes_max` at its edge (exactly at it accepted, one need over refused, naming it); the same for `host_held_bytes_max`;
- a host's held-credit lease retried after a lost answer leases once; a return from another agent DO is refused;
- **TESTS:** an agent answering, then stale, then answering again moves its bytes in and out of the stale total exactly once per transition (reported within `stale_report_ms`);
- a send to an answering agent makes no directory call for bound 3 (counted).

---

## Agent messages (M7): r12.6, a delta on r12.5 (26f57ae8) for Codex's hold on r12.4 (two P3 items)

r12 to r12.5 stand except where this changes them. Codex's r12.4 item 1 (E3) crossed with r12.5, which replaces E3. This delta states r12.5's guarantee for any number of hosts that stop answering, and corrects r12.4 E4's property.

### G1. r12.5's guarantee, for k hosts that stop answering

r12.5 stated the guarantee for one misbehaving host. In general, with any set S of hosts that stop answering (offline, connected and silent, or slow), at any moment:
- the stored total never passes `fleet_storage_bytes` (r12.4 E1's leases);
- the hosts outside S can use at least `fleet_storage_bytes` - max(`stale_pool_bytes`, the held bytes of S's agents), and the held bytes of S's agents are at most |S| x `host_held_bytes_max` (r12.5 bound 2);
- so with k = |S|, the others keep at least `fleet_storage_bytes` - max(`stale_pool_bytes`, k x `host_held_bytes_max`). At the defaults (10% per host, 25% pool): k = 1 or 2 leaves at least 75%; k = 5 leaves at least 50%; and the bound reaches 0 only when 10 or more hosts stop at once.
- **Codex's example** (online hosts holding 90 of 100 when they stop): the bound's input is the held bytes per host, which can't pass 10 per host. So 90 held needs at least 9 hosts. When those 9 stop answering, the 90 stays held: it isn't freed, and the others keep at least 100 - 90 = 10, exactly as the formula says. Nothing claims that the 75 stays reserved in that case.
- **Admission keeps the future transition bounded:** bound 2 is checked at every send, while the host is still answering, so no host can build a backlog larger than `host_held_bytes_max` before it stops. That's the admission rule for the online-to-stale transition.
- **The Agents page** shows the hosts in S and their held bytes, so the person can see which hosts are holding the budget.
- **Rows:**
  - Codex's transition with an existing backlog: 9 hosts each holding exactly `host_held_bytes_max` while answering, then all stopping: their held bytes stay counted; sends to their agents are refused (stale pool, then host cap); the tenth host's agents keep sending within budget - 9 x `host_held_bytes_max`;
  - a host at `host_held_bytes_max` while answering: its next send is refused `limit (host_held_bytes_max)` before it ever stops, so its backlog can't grow at the transition;
  - k = 1, 2 and 5 at the defaults: the other hosts' usable bytes are at least 75%, 75% and 50% of the budget.

### G2. r12.4 E4's property counts certified deletions

Codex: E4's invariant ("every committed seq was named by a notify the host received or returned by a pull") excludes seqs certified deleted. Its schedule: send 1, send 2, delete 1 (its thread), before any notify or pull. The coalesced hint names 2, the pull returns 2 with `through` 2, and seq 1 is correctly certified deleted but meets neither branch.

**The property, restated:** after the schedule's final catch-up, for every agent, the host's cursor is the agent DO's `head`. And every committed seq s at or below it is one of:
- returned by a pull the host made; or
- inside a pull's certified interval (`after`, `through`] without being returned, and deleted before that pull's snapshot (r12.3 F1).

No seq is in neither, and none is in both a returned record and a certified-deleted gap.

**Rows:**
- Codex's schedule (send 1, send 2, delete 1, then the coalesced notify and pull): the pull returns 2 with `through` 2, seq 1 is certified deleted, and the property holds;
- the generated schedules of r12.4 E4, with deletions included, checked against the restated property.

---

## Agent messages (M7): r12.7, a delta on r12.6 (77aa255d): G1's bound corrected (SEC R2), and re-grant moves held bytes (SEC R1)

r12 to r12.6 stand except where this changes them.

### G1, corrected: the two terms add

r12.6 G1 gave the others' usable bytes as `fleet_storage_bytes` - max(`stale_pool_bytes`, k x `host_held_bytes_max`). That is too optimistic. Two things count separately:
- the held bytes of the k hosts that stopped answering, at most k x `host_held_bytes_max` (r12.5 bound 2);
- the stale bytes of everyone else's admitted sends, capped for new admissions by `stale_pool_bytes` (bound 3).

**The guarantee:** with k hosts that stop answering, the other hosts' agents can use at least `fleet_storage_bytes` - `stale_pool_bytes` - k x `host_held_bytes_max`, and never less than 0.
- At the defaults (25% pool, 10% per host): k = 1 leaves at least 65%, k = 2 at least 55%, and k = 5 at least 25%. The bound reaches 0 at k = 8.
- In Codex's example (9 hosts each holding their full 10%), the bound is 0: nothing is reserved for the others. They can still use whatever the budget has free.
- **The cost of raising the per-host cap** follows from the formula: each 1% added to `host_held_bytes_max` takes k% from the others' guaranteed share. The Agents page shows the current guaranteed share for k = 1, so an operator sees the cost.
- r12.5's one-host figure becomes the example for k = 1 (65%: 6.5 GiB of 10 GiB, as r12.5 said).
- **Rows** (replacing r12.6 G1's k rows): k = 1, 2 and 5 at the defaults leave at least 65%, 55% and 25% usable by the others; 9 hosts each holding their full cap, then stopping: the others' sends are accepted while the budget has free bytes, and nothing beyond that is promised.

### R1. A re-grant moves an agent's held bytes to the new host

When an agent moves from host H1 to H2 (r12.1 T4's re-grant row), its held bytes were leased as held credit from H1's channel DO.
- Before H2 admits any send to that agent, the agent DO leases held credit from H2's channel DO for the agent's existing held bytes. If that would pass H2's `host_held_bytes_max`, the send is refused `limit (host_held_bytes_max)` and the agent's held bytes count toward H2 all the same: moving doesn't shed them.
- Once H2's credit is held, the agent DO returns H1's lease (idempotent by lease id, from the holder only: r12.5).
- So a host can't shed its count by having its agents re-granted elsewhere, and the fleet's held total is counted once throughout: never zero times, and never twice past the return.
- **Row:** an agent holding bytes is re-granted from H1 to H2. H2's held count includes them before its next admission. H1's count drops by the same amount once the return lands. The fleet total stays the same throughout.

---

## Agent messages (M7): r12.8, a delta on r12.7 (5304b98f): r12.6 G1's bound restored

r12 to r12.7 stand except where this changes them.

- **r12.7's G1 section is withdrawn, and r12.6 G1 stands as written:** the other hosts' agents can use at least `fleet_storage_bytes` - max(`stale_pool_bytes`, the held bytes of S's agents), where S's held bytes are at most |S| x `host_held_bytes_max`.
- **Why the max form holds (SEC's check of r12.6):**
  - every host with a stale message is, by definition, in S (it has stopped answering), so the hosts outside S hold no stale bytes;
  - S's held bytes are bounded by r12.5's bound 2, checked at admission while each host still answered;
  - so the others' usable space is at least the budget minus S's held bytes, and taking the max with `stale_pool_bytes` only makes the bound more conservative.
  r12.7's sum is also a true lower bound, but it is weaker and was withdrawn in error.
- **The numbers at the defaults** are r12.6's: at least 75% for k <= 2, at least 50% for k = 5, and 0 from k = 10. In Codex's 90-of-100 example, nothing is freed and nothing is claimed to be.
- **Rows:** r12.6 G1's rows stand (k = 1, 2 and 5 leaving at least 75%, 75% and 50%), and r12.7's rows for G1 are withdrawn.
- **r12.7's R1** (a re-grant moves an agent's held bytes to the new host's count before its next admission) **stands**, with its row. It is what keeps G1 true across a re-grant.

---

## Agent messages (M7): r12.9, a delta on r12.8 (f4955e87): the k-host bound, settled

r12 to r12.8 stand except where this changes them. This settles the G1 bound that r12.6, r12.7 and r12.8 went back and forth on, after SEC's final check.

- **r12.8 is withdrawn in full, and r12.7 G1 stands.**
- **S** is the set of hosts that have stopped answering entirely: offline, or connected and answering nothing. A host that is slow on some agents but still answers others is outside S, and its stale bytes can fill up to `stale_pool_bytes`. So the two terms add, as r12.7 has it.
- **The guarantee:** the other hosts' agents can use at least `fleet_storage_bytes` - `stale_pool_bytes` - (S's held bytes), floored at 0.
  - **S's held bytes** are at most |S| x `host_held_bytes_max`, plus any held bytes that came to a host by re-grant over its cap (r12.7 R1). A re-grant is a person's act, never a host's, so a misbehaving host can't cause that excess.
  - With no host over its cap, the bound is `fleet_storage_bytes` - `stale_pool_bytes` - k x `host_held_bytes_max`. At the defaults that is 65%, 55% and 25% for k = 1, 2 and 5, and 0 from k = 8. Codex's 9 full hosts leave a guarantee of 0, stated as such.
- **The Agents page** marks a host whose held bytes are over its cap ("over its cap after a re-grant"), next to the held bytes it already shows against `host_held_bytes_max`.
- **Rows:** r12.7 G1's rows (65% / 55% / 25%, and the 9 full hosts) and r12.7 R1's re-grant row stand. r12.6 G1's rows (75% / 75% / 50%) stay withdrawn. One new row: a re-grant puts H2 over its cap; H2 is marked over its cap, its next sends are refused `limit (host_held_bytes_max)`, and the others' bound counts H2's actual held bytes.

---

## Agent messages (M7): r12.10, a delta on r12.9 (ae8f73ed): held credit moves only when it fits (Codex, on R1)

r12 to r12.9 stand except where this changes them.

**Codex's gap (on r12.7 R1).** R1 counted a re-granted agent's held bytes at the new host "all the same" and refused only its next send, so one host could come to hold several hosts' worth. Example (budget 100, pool 25, host cap 10): H1 to H4 each legally hold 10. Re-granting the agents of H1, H3 and H4 into H2 leaves H2 holding 40. If only H2 then stops, k = 1 but S's held bytes are 40, leaving 60, below the k = 1 figure, without any send ever admitted past a cap.

**The rule (Codex's option a), replacing r12.7 R1's "count toward H2 all the same" and r12.9's re-granted-in term:**
- **A host's held count is what it OWNS.** Held credit for an agent's existing held bytes moves from H1 to H2 only as one atomic step, and only when the whole amount fits H2's `host_held_bytes_max` beside what H2 already holds.
- **Until it fits,** ownership of those bytes, and their place in the k-host count, stay with H1 (or with each old host, for agents re-granted from several). The bytes stay counted exactly once, at their owner.
- **Meanwhile the agent receives no new sends** (refused `limit (host_held_bytes_max)`, `retry_ms: null`). Its held bytes shrink only as its existing messages are answered or their threads deleted, through H2 as its host now. Once the remainder fits, the transfer happens at the agent's next send or alarm.
- **So no host's owned held bytes ever pass `host_held_bytes_max`, by sends or by re-grants,** and S's held bytes are at most |S| x `host_held_bytes_max` with no exception.
  - r12.9's figures hold as stated: 65 / 55 / 25% for k = 1 / 2 / 5, and 0 from k = 8 with S = the hosts that stopped answering entirely.
  - Equivalently, with S = every host holding a stale message, the max form's 75 / 75 / 50%.
- **The Agents page** shows such an agent as "moving: waiting for its held messages to fit host H2", naming the old host that still holds them. r12.9's "over its cap" mark is withdrawn, since a host can no longer be over its cap.
- **Rows:**
  - **Codex's many-full-hosts-into-one re-grant:** H1 to H4 each holding their cap, then H1's, H3's and H4's agents re-granted into H2. No transfer happens while it wouldn't fit. H2's owned held bytes stay at its cap, those agents' sends are refused, and if only H2 then stops, the others keep at least the k = 1 figure;
  - a re-granted agent whose held bytes fit H2: one atomic transfer, H2's count up and H1's down by the same amount, and the fleet total unchanged throughout;
  - a re-granted agent that doesn't fit yet: its messages are answered through H2, its held bytes shrink, and the transfer happens once they fit, never partially;
  - a transfer retried after a lost answer moves the credit once (idempotent by lease id, as r12.5).

---
