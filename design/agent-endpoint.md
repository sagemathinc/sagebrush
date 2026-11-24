# The agent endpoint: agents in a synced workspace

*Status: design, for review by astra (correctness), daybreak2 (limits) and William. Not built yet. When built, it stays behind the sync service's flag, which is off in production (design/sync-server.md §11).*

This is design/workspace-files.md §8.2's third surface, "Anywhere, with sync", together with §8.4's grants and access log. With it, a person's own agent (Claude Code or Codex on any computer, or an agent in a cocalc.ai project) can work in their workspace through the workspace API's verbs, without a page the agent drives. It is built on the sync server (design/sync-server.md), and the account object holds the grants, tokens, rates and access log.

**Under end-to-end encryption** (decided Nov 23; design/e2e-encryption.md §6), the server can't read the workspace. So every verb is relayed to an online device of the person's, which decrypts, checks the grant's scope and answers (§4). With no device online, the agent is told to wait.

**What it is not:**
- **It runs no code, and reads no data.** A run is relayed to an open page of the person's, and happens there in the runner (§6). Every other verb is relayed to a device too (§4).
- **It is not the in-page surface** (`window.sagebrush.workspace`) and not the local MCP adapter. Those act with the page's authority (§9.2).

---

## 1. The grant

A grant is made by a person to one agent. Its fields:

```
grants(
  id            12 base32 chars, random
  agent         the agent's name as the person sees it ("Claude Code on laptop", "cocalc: number-theory/claude")
  token_hash    SHA-256 of the token's secret
  scopes        JSON: [{path, access: "read" | "write"}], up to the membership's `scopes_per_grant`
  run_code      0 | 1           "may run code" (§6)
  outward       JSON: the outward actions granted beforehand, [] by default (§5)
  rate          JSON: optional person-chosen reductions to this grant's membership limits (§7)
  created, expires, last_used, revoked, revoked_reason
)
```

**Under end-to-end encryption** (design/e2e-encryption.md §4, §6), the grant is split:
- **sealed to the person's devices,** which alone read and enforce them: `agent`, `scopes`, `run_code` and `outward`;
- **kept by the server,** to admit and limit requests without reading anything: `id`, `token_hash` and its tag, `rate`, `created`, `expires`, `last_used`, `revoked`, and its `gen` (design/sync-server.md §4.5), which rises with every change to the grant, a narrowed scope included.

- **Scope** is a list of folders or files, each read or read-and-write.
  - A path covers itself and everything under it, matched on whole segments, so `/Algebra` doesn't cover `/Algebra2`.
  - Paths are normalized by the same `normPath` the client uses, with its tests.
  - `/` is the whole workspace, and the grant dialog says so plainly.
- **Trash:**
  - an agent with write access may `remove` within its scope, which moves an entry to `/Trash/`, and `restore` what was removed from its scope;
  - it sees only the Trash entries that came from its scope (`trashed_from`);
  - no verb empties Trash (§8.2).
- **Expiry:** the dialog proposes 30 days; its maximum is the membership's `grant_days_max`. It is shown, and can be extended only by the person.
- **Live grants are a membership capacity.** At `live_grants`, the person revokes one or moves to the membership named by the refusal (§7).

## 2. The token

**Its form:** `sbg1.<account hash, 64 hex>.<grant id>.<secret, 32 random bytes, base64url>.<tag>`.
- **The tag** is `HMAC-SHA256(GRANT_TAG_KEY, "sbg1." + hash + "." + grant id)`, the first 16 bytes, in base64url. Only the server can make one (LIMIT-D817-1).
- **The Worker checks the token's exact form and its tag before anything else,** and before the hash names an object. A made-up or altered token gets 401 from the Worker, and never reaches a Durable Object. Failures count against the IP's pre-authentication limit (design/sync-server.md §2).
- Only then does the Worker find the account object from the hash, and the object find the grant from the id. No D1 read and no global table is in the path.
- **A refused token never writes:** the account object only reads the grant row to refuse it. The access log records refusals only for a grant that exists, at most one row a minute per grant.
- A leaked `GRANT_TAG_KEY` would let made-up tokens reach objects, though they still fail at the secret. Rotating the key is a new token version, `sbg2`, with every person asked to renew.
- The account object stores only `SHA-256(secret)`, and compares in constant time (sharing's `same`).
- The hash names the account without its id, and reveals nothing an attacker can use: the secret is what grants access.

**How a grant is issued** (§8.9 question 1): always by the person, on sagebrush.space, from a signed-in session. Never by the agent, and never by cocalc.ai on its own. There are two ways:

1. **Pairing**, for an agent with a terminal or a chat, a flow like OAuth's device authorization (RFC 8628):
   - the agent calls `POST /api/agent/v1/pair` with `{agent, wants: {scopes, run_code}}`, and gets back `{pair_id, code: "WXYZ-1234", url, poll_secret, interval: 5}`, where the URL is `https://sagebrush.space/agents/pair`;
   - the agent shows the person the URL and the code;
   - the person opens the URL, signed in, and types the code. The page shows what the agent asked for, which the person can narrow but never widen beyond what they choose, and they approve;
   - meanwhile the agent polls `POST /api/agent/v1/pair/<pair_id>` with its `poll_secret`, and receives the token once, after approval;
   - a pairing expires after 10 minutes, and gives its token only once, to the holder of `poll_secret`.

   **Pairing is the one route before any account, so its bounds are all stated** (LIMIT-D817-2). Its records are a D1 table, `pairings(pair_id, code_hash, poll_hash, ip_hash, wants, state, created, expires, polls, last_poll, account, grant)`, written when a pairing is made, approved and collected. It is never written on an edit.
   - **The request:**
     - at most 4 KiB of JSON;
     - `agent` at most 64 characters;
     - `wants.scopes` must fit the structural 4 KiB request and every path is checked by `normPath`; on approval, the account applies its membership's `scopes_per_grant` and the person may narrow the request.
     - Anything else is refused with 400 before any write.
   - **Making one:**
     - the IP limit first (Cloudflare's rate-limiting binding, 10 an hour per IP);
     - then one conditional INSERT that holds only while the IP has fewer than 3 pairings pending, and the whole site fewer than 10,000. Otherwise it is refused with 429, or with 503 "pairing is busy".
     - IPs are stored only as an HMAC with a key that changes daily.
   - **Polling:**
     - at most once every 5 seconds per pairing. Faster gets `slow_down`, as in RFC 8628, and the interval grows by 5 seconds;
     - at most 150 polls per pairing, and 60 a minute per IP (the binding);
     - each poll is one D1 read, and one write only when it slows down or collects;
     - a wrong `poll_secret` never says whether the pairing exists.
   - **The code** is 8 characters from a 32-letter alphabet, 40 bits, stored as an HMAC.
     - Approving needs a signed-in session, and is limited to 5 wrong codes an hour per account, and 1,000 a minute for the whole site.
     - A pairing approved by one account can't be approved again.
     - After approval, the 5-pending-per-account limit applies.
   - **Clean-up, which can't be made to grow:**
     - each INSERT first deletes at most 20 expired rows;
     - the scheduled job deletes every row an hour past its expiry, 1,000 at a time;
     - **no token is ever stored:** approval makes the grant without a secret. The first poll after approval makes the secret, has the account object store its hash, and returns the token once. A second collection finds the pairing `collected`.
   - **Failure paths never disclose a token:** an expired, used or unknown pairing gets the same 404.
2. **From the grant dialog,** for an agent the person configures by hand:
   - the person makes the grant and copies the token, which is shown once;
   - this is also how a token reaches a cocalc.ai project, pasted as a project secret, until the cocalc.ai adapter (§10) does it for them.

**Rotation:**
- "New token" in the Agents with access panel replaces the secret. The old one stops working at once.
- There are no refresh tokens: an agent can't extend or widen its own grant.
- An expired grant stays listed, greyed, with "Renew", which makes a new token for the same scope after the person confirms.

**Where a token must never be:** in a URL, in a document, or in a log. Requests carry it only as `Authorization: Bearer`. The access log records the grant's id, never the token.

## 3. Requests

- `POST /api/agent/v1/<verb>`, with JSON in and JSON out, and `Authorization: Bearer sbg1…`.
- A socket at `GET /api/agent/v1/socket`, carrying the same bearer token, for `watch`, `chat.next` and relayed runs.
- **No cookies, and no CORS:**
  - a session cookie is ignored on these routes, so a page can't use the person's session through them;
  - a request with an `Origin` header (that is, from a web page) is refused. Agents aren't browsers, and a token pasted into a hostile page can't be read back through CORS anyway.

**At the Worker, before any object:** the IP's pre-authentication limit, and then the token's form and tag (§2).

**Then, in the account object: admission only.** Under end-to-end encryption the server can't read a path, a scope or a document, so it checks only what it holds (§1):
1. The grant exists, isn't revoked or expired, its secret matches, and the account is `active` (or `readonly`, for reads). On dev, the account must also be in `SYNC_ACCOUNTS` (design/sync-server.md §11).
2. The grant's rate limits, and then the account's (§7).
3. The request goes, opaquely, to an online device of the person's (§4), with the grant's id and current `gen`. With none online, it waits (§4).

**On the answering device, which decides everything about content:**
4. The verb's paths are inside the grant's sealed scope, with the access the verb needs (read, or write); an outward action is granted beforehand or confirmed (§5); a run is the agent's own code (§6).
5. The verb runs through the workspace API. A write becomes ops or patches that the device seals and signs, credited to the agent and naming the grant's id and the `gen` it checked.
6. The device writes the access log's row, encrypted (§8).

**Revoking, and fences, without reading a path:**
- **A write to the index** (an op) is accepted by the account object only if its grant is live and the `gen` it names is the grant's current one, in the op's own transaction. So a revoke, or any change to the grant, that lands while the request runs prevents the write.
- **A write to a document** is admitted, and then fenced if it must be (design/sync-server.md §4.5): the account object records an admission for the grant's id and `gen`; the document object commits it only if it isn't fenced and hasn't expired (60 seconds); a revoke or a change to the grant cancels pending admissions, and completes only once they are fenced or expired. So no write admitted before a revoke commits after the revoke completes.
- **A rename out of scope** is the person's own op, which the server can't see the meaning of. It is caught where the paths are known: every device reduces the log in the same order, and an agent's op whose path is outside its grant's scope at that point in the log is refused by every device alike, as any op is under the deterministic reducer (design/e2e-encryption.md §4).

**What a refusal says:**
- 401 `unauthorized`: no such grant, a wrong secret, or expired or revoked. The answer never says which;
- 403 `scope`: the path, and which access was needed;
- 403 `needs_confirmation`: an outward action (§5);
- 429 `rate`: with `retry_after` and the limit;
- 413 `limit`: with which limit;
- 409 `conflict`: with the current revision;
- 409 `no_page`: a run needs an open page (§6).

## 4. The verbs

**The verbs are the workspace API's (§8.2), generated from its schema** (`web/workspace/schema.json`, made from the TypeScript types). The same schema generates the MCP tools, so the surfaces can't drift apart.

**Every verb is relayed to a device** (design/e2e-encryption.md §6):
- **Where it goes:** an online device of the person's: an open tab, the desktop app, the sagebrush CLI or an Autonomous VM. Each is a full trusted device in the account's key chain, able to read everything the account holds: a grant limits what the agent does, not what that device can read (decided: no per-folder keys). The account object picks one, as it picks a page for a run (§6), and forwards the request opaquely.
- **What the device does:** it decrypts, checks the grant's scope (`inScope`, and the Trash visibility rule for grants, `trashVisible`), does the verb through the workspace API, and answers. The grant's scopes are sealed to the person's devices: the server keeps only the grant's id, token hash, tag, rates and expiry.
- **With no device online,** the endpoint answers "waiting for one of your devices" and queues the request opaquely. It never decrypts.
- **Open, for the endpoint's own design with SEC:** how the request and the answer travel end to end between the agent and the answering device, so that the server relays only ciphertext in both directions. For example, a key the agent presents at pairing, which the person's device certifies. Until that is settled, the endpoint isn't built beyond DEV's `list` and `stat`.
- **Today, on DEV:** only `list` and `stat` are built, and they answer from the server's derived index (`entries`, design/sync-server.md §3). That index goes away when index ops are sealed, and these two verbs move to the relay with the rest. The other verbs answer `not_built`, so nothing is lost by making them relay-only from the start.

| Verb | Access | What the device does |
|---|---|---|
| `list`, `stat` | read | from its index, filtered to the scope |
| `read` | read | a data file: its bytes, decrypted. A document: its current value (below) |
| `write(path, content, {base})` | write | a data file: blob, then op, with compare-and-swap on its `sha256`. A document: a patch (below) |
| `create`, `mkdir` | write (the parent) | an op, credited to `agent:<name>` |
| `rename`, `duplicate` | write (both paths) | an op |
| `remove`, `restore` | write | an op (to Trash and back) |
| `history`, `version` | read | a document's batches; a data file's versions |
| `watch(path)` | read | the ops and `changed` within the scope, as the device sees them |
| `run(path, cell or note)` | write and `run_code` | relayed to a page (§6) |
| `chat.next`, `chat.reply` | the chat document's access | §8.7's remote adapter: messages are patches on a `.chat` document |
| `files.batch` | each item's access | many small reads/writes/ops in one idempotent request (design/fs-sync-scale.md §2) |

- **Not verbs:** emptying Trash, clearing a history, dropping versions, making or changing grants, deleting synced data. Only a person, from a session, may do these (§8.2, §8.3).
- **Ops and patches from a grant are credited:** `by: "agent:<name>"`, device `grant:<id>`, and author `agent:<name>` on each patch. The device sets these from the grant, never from the request, and signs them as its own.

**Documents.** Notebooks, boards and chats are patchflow logs, ciphertext to the sync objects (design/sync-server.md §10). Only the person's devices read them:
- `read` and `write` on a document use the same patchflow codecs as the pages (web/notebook/history.js, web/board/history.ts);
- the device reads the latest snapshot and the batches since (design/sync-server.md §5.2 `pull`), and computes the value;
- for `write`, it makes the patch from `base` to the new value, and sends it as a one-patch batch with `expect_head` set to the head it read (design/sync-server.md §4.4), from the grant's own patchflow client (`grant:<id>`), credited to the agent;
- **its bounds:** `document_bytes` of value and `document_batches` since the snapshot, from the account's membership record (design/fs-sync-scale.md §1). Beyond either, it answers 413 `limit`, with the tier metadata of §7, and suggests opening the page;
- **a write is compare-and-swap,** checked in the document object's transaction. If the document has moved past `base`, it answers `conflict` with the current revision, as the in-page API does. A resend after a lost answer gets the original `seq`, not a conflict.

## 5. Outward actions

These are §8.3 danger 3:
- sharing or publishing;
- sending to the Inbox or by email;
- granting;
- turning sync on for a folder;
- spending.

Each needs either a scope granted beforehand, or the person's confirmation at the time:

- **Granted beforehand** (`outward`), for example `{share: {path: "/Public"}}` or `{spend: {usd_per_day: N}}`, set only in the grant dialog.
- **Otherwise:**
  - the verb answers 403 `needs_confirmation` with a `confirm_id`;
  - the person's open pages show "Claude wants to share /Algebra/Sylow.board.json: Allow or Deny";
  - the agent can wait for the answer on its socket;
  - a confirmation applies to that one action, with exactly those arguments, for 10 minutes. With no page open, it waits until one opens, or until it expires.
- **Granting is never pre-grantable.** No grant can make or change grants, its own included.
- **Under end-to-end encryption,** `outward` is sealed with the scope, so the answering device checks it, and asks for and checks the confirmation. The server only relays the request and the person's answer, opaquely.

## 6. Running code

**A remote agent's runs happen only in an open page of the person's** (§8.3). The server has no compute.

- **`run` needs `run_code`** on the grant, and write access to the document.
- **The relay:**
  - the account object picks a page that is connected on the account socket, says it accepts relayed runs (it has the document's interpreter available), and has had the person's input within the last 12 hours;
  - it sends the page `{t: "run", run_id, grant, version}` and the request, sealed: the path, the target and `code_sha256` are inside it, never visible to the server;
  - with no such page, it answers 409 `no_page`, and never queues a run.
- **The page decides,** from the grant's sealed fields, which it reads as any device does:
  - the grant still allows running in that path;
  - **the code is the agent's own** (§8.3, "code that agent wrote"): the cell's or note's current input was last changed by a patch authored by this grant's agent, and its SHA-256 is `code_sha256`. Code that another person or agent last changed is not this agent's to run. The agent can rewrite it, which makes it the agent's own, credited to it and visible in TimeTravel;
  - the run happens in the runner, never in the fallback worker (§8.3, danger 2). If the runner isn't available, it is refused with `runner_unavailable`.
- **The person sees it:** a running indicator naming the agent, with Stop, and an entry in the conversation or the document's history.
- **The result** is the run's outputs, bounded as the page bounds them (design/security.md rules 1-4). It goes back through the account object to the agent, sealed (§4's open point), and the page logs it, with the code's hash, in the encrypted access log (§8).
- **Revoking reaches a running run** (§8.9 question 3):
  - turning off `run_code`, or revoking the grant, sends `{t: "grant", id, run_code: false}` or `{t: "revoked", grant}` to every page of the account;
  - a page stops that grant's runs at once, by the runner's Stop;
  - a page that missed the message refuses at its next check, because every relayed run carries the grant's current `gen` from the account object, and a page with an older copy of the grant fetches it first.

## 7. Limits, sizes and rates

Every authenticated product capacity comes from the account's required `sync.agent` membership record (design/fs-sync-scale.md §1), inside the account's storage claim. A grant may reduce its own values; it cannot raise them. There are no compiled product defaults.

| Agent surface | Membership fields |
|---|---|
| request/operation pacing | `requests_per_minute`, `requests_per_hour`, `ops_per_minute` |
| bytes and one file | `read_bytes_per_day`, `write_bytes_per_day`, `max_file_bytes` |
| small-file batches | `batch_files`, `batch_bytes`, `batch_concurrency` |
| blob/URL concurrency and pacing | `blob_concurrency`, `signed_urls_per_minute` |
| workspace populations | `workspace_entries`, `folder_entries` |
| document materialization | `document_bytes`, `document_batches` |
| runs, sockets and confirmations | `runs_concurrent`, `runs_per_hour`, `sockets`, `confirmations` |
| grant population, scope count and expiry | `live_grants`, `scopes_per_grant`, `grant_days_max` |
| Inbox item, queue and sender/day capacities | `inbox_item_bytes`, `inbox_waiting_items`, `inbox_items_per_sender_per_day` |

Listing page/call sizes and examined rows are advertised server capabilities, clamped to host safety ceilings rather than membership benefits. Read bytes are debited when authorized: a signed URL debits the whole blob and is single-use for a grant; a document read debits its value. Write bytes are reserved before a body or blob is retained. A newly admitted `files.batch` uses one request token in both request buckets, reserves every item's operation and logical bytes before work, and never debits product meters again for its idempotent retries (design/fs-sync-scale.md §2).

Over a product value, the answer is the structured 429/413 of design/fs-sync-scale.md §1.2, including the current tier and the least membership that raises it. Exact COPY is shared by the CLI and site. An unauthenticated abuse or structural safety refusal never advertises an upgrade.

Every check and reservation precedes its write. For a batch, admission reserves the whole ledger, publication splits beneath the host's 500-ops internal-message capability under one durable identity, and each item has stable idempotent results; no item is half published. A batch read returns the same `epoch.head_seq` revision token as list/stat and never exceeds `document_bytes` for a document value.

## 8. The access log

- **One row per request, written by the answering device, encrypted:** time, grant, agent, verb, path (or paths), result, bytes, and for a run, the code's SHA-256. A request's arguments and contents are never logged.
- **The server keeps the row as ciphertext,** with only its time, size and grant id visible (design/e2e-encryption.md §4). It never holds a path or a code hash.
- **Kept for 7 days, and at most 100,000 rows per account. The oldest go first.** Age and count are independent host bounds, so sustained traffic can evict a younger row at the count cap. Append and cleanup are bounded. Retention is not a membership field or tier benefit, so zero and downgrade cannot trigger separate early trimming.
- **Who may read it:** the person, in "Agents with access", per grant or all together. An agent can't read the log, its own entries included.
- **It is the person's data.** It is deleted with their synced data, by "Delete my synced data" and by the purge (design/sync-server.md §7). Sagebrush's operators have no view of it.
- **"Undo this agent's changes"** uses TimeTravel's attribution, which every op and patch carries (§4), not the log. The log says what an agent asked for, and the history what it changed.

## 9. Answers to design/workspace-files.md §8.9

1. **How tokens are issued, stored and rotated.**
   - Issued by the person on sagebrush.space, by pairing or from the grant dialog (§2).
   - Stored only as a SHA-256, in the account object.
   - Rotated by the person, and the old one stops at once. There are no refresh tokens, and expiry is at most the membership's `grant_days_max`.
   - cocalc.ai can't issue one by itself. The adapter (§10) asks the person through the same pairing.
2. **An in-page agent's grant.**
   - The page holds the person's whole authority. Anything that drives the page (CDP, Playwright, the shared browser) can call any of its code, so no limit inside the page is a security boundary against it.
   - **Proposed:** an "agent mode" in the page (`workspace.asAgent(name, scopes)`). It gives a `Workspace` whose verbs check the scope, credit `agent:<name>`, and refuse the person-only verbs.
   - It is worth having, because it makes an agent's mistakes stay in scope, and makes its changes undoable by agent. But it is a guard rail, and it isn't presented as more.
   - The real boundary for an agent the person doesn't fully trust is a remote grant (this endpoint), or the local MCP adapter with a pairing (§8.7). In both, the page enforces the grant, not the agent.
3. **"May run code".**
   - **The runner fallback:** a relayed run is refused when the runner isn't available, and never falls back (§6). The page enforces this in one function, `runFor(actor)`, where an actor other than the person means `runner: "required"`.
     - Test: the runner frame is blocked; an agent's run is refused with `runner_unavailable`, and the person's own run falls back as now.
     - A mutation that allows the fallback must fail the test.
     - This is client work (@sagebrush-board and @sagebrush-python), and is listed for them.
   - **Is anything missing from the list of what reaches outside?** One thing is: **a document the agent writes can call out when the person opens it,** if anything in it loads from the network (a Markdown image, a link that prefetches, a board picture by URL). That would turn private content into a request to the agent's server, with the person's IP address, and data in the URL.
     - The rule that closes it: what a document shows loads nothing from other sites (design/security.md rule 3, and the CSP's `img-src`).
     - It must cover everything an agent can write, including chat messages and board notes, and it is tested for agent-written content in particular.
     - Links the person clicks are the person's action, and are shown as links to other sites.
   - **The boundary "code that agent wrote"** is enforced as "the current input was last changed by this agent's patch" (§6). Code an agent copied from a shared document into its own edit counts as its own. That can't be told apart, and it is the agent's responsibility, inside its grant. What stays enforced:
     - another person's edit never runs by itself;
     - an agent never runs code someone else last changed.
   - **Revoking a running run:** §6.
   - **Retention:** a write that can't keep the previous version is refused by the device doing the write, which also sends the retention op, since under end-to-end encryption the server can't keep a version on its own (design/e2e-encryption.md §4). Filling the quota on purpose therefore blocks writes, and loses nothing.
4. **Rates and sizes per verb:** §7. An over-limit agent sees 429 or 413, with which limit it hit and when to retry.
5. **The access log:** 7 days and 100,000 rows. Readable by the person only (§8).
6. **The Inbox.**
   - **Who may send:**
     - the person's own grants with `outward.inbox` (their cocalc.ai agents);
     - accounts the person has allowed by name.
     - Nobody else, so the Inbox can't be used to spam.
   - **Membership capacities:** each item is at most `inbox_item_bytes`, at most `inbox_waiting_items` wait at once, and one sender may add at most `inbox_items_per_sender_per_day` a day. A refusal uses §7's upgrade-bearing answer.
   - **An item is a read-only entry under `/Inbox/`.** Its code never runs, as with a shared collection.
   - **Accepting it** moves it into the workspace as the person's own copy. Its origin (who sent it, when) is kept on the entry. It is still never run by itself: the person runs it.
   - **Declining it** deletes it.
7. **Another person's grant and the owner's files.**
   - **Settled by end-to-end encryption:** no other account ever writes or reads the owner's documents. Another person gets an encrypted copy under their own keys, and proposes changes back (design/workspace-files.md §7.9). Live collaboration, and with it collaborators' grants, was dropped (design/e2e-encryption.md §5.1).
   - So a grant covers only what the granting account owns. Another person's grant reaches only their own copy, never the owner's files, and nothing has to be checked against an access list.

## 10. The cocalc.ai adapter (step 11), in outline

The panel of §8.7 talks to a person's cocalc.ai agents through CoCalc's Agent Network. This needs work on the CoCalc side, which @sagebrush-auth designs with the cocalc.ai agent team in its own short note. Its outline:

- **The sender is the person, through their Sagebrush page.** CoCalc gets a new OAuth scope, `agents:message`, which the person approves at sign-in. The Sagebrush server uses the token from that scope to send as the person: never as an agent, and never on its own.
- **Addressing:** `cocalc agent destinations` for the person's account, shown in the panel.
- **The flow:**
  - a message the person types becomes a CoCalc Agent Network message from the person's account to that agent, with `reply_to: sagebrush:<chat document>`;
  - the agent's reply comes back through the Sagebrush server, which writes it into the `.chat` document as a patch credited to `agent:<name>`;
  - so it is on every device, and in TimeTravel.
- **The agent's access to the workspace** is an ordinary grant (§1), made through pairing, which the adapter starts and the person approves.
- **What stays the same:**
  - the person's messages are instructions;
  - everything else reaches the agent labelled as content (§8.7, Security).

## 11. Tests

In Miniflare, with the sync server's harness:

- **Before authentication:** a fresh, made-up account hash on every request, a bad tag, and a malformed token each get 401 from the Worker, create no object and write no row; the IP limit stops a flood.
- **Pairing:** an oversized body is refused before any write; a fourth pending pairing from one IP, a full site, polling faster than 5 s (`slow_down`), more than 150 polls, and expired rows are each handled as §2 says; no failure path shows a token.
- **Reading:** a grant's URL debits at issue and works once; parallel and overlapping range requests on it give at most one success.
- **Document writes:** a competing append between the read and the write gives `conflict`; a revoke while the write is delayed either finds it committed (and logged) or refuses it.
- **Grants, on the server:**
  - a token for another account, a wrong secret, an expired grant and a revoked grant each give the same 401;
  - a revoke, or a change to the grant, while a write is running prevents the write: an op or admission naming an old `gen` is refused;
  - revoking closes the grant's sockets;
  - a pairing is used once, by the holder of its secret only, and a wrong code fails 5 times and then the pairing ends;
  - **nothing the server stores or logs holds a path, a scope or a code hash:** every request, relay message and log row is checked for them.
- **Scope, on the answering device:**
  - `/Algebra` doesn't cover `/Algebra2`;
  - `..`, `.`, `//` and other spellings normalize to the same path, or are refused;
  - an agent's op after a rename out of its scope is refused by every device alike;
  - Trash shows only what came from the scope.
- **Person-only verbs** (emptying Trash, clearing a history, dropping versions, granting, deleting synced data) are refused for every grant.
- **Outward actions** need a confirmation, or a scope given beforehand, checked by the device. A confirmation covers exactly one action, with those arguments.
- **Runs:**
  - refused without `run_code`, without a page, and for code the agent didn't last change;
  - refused when the runner isn't there;
  - stopped when the grant is revoked.
- **Limits:** each row of §7, at the limit and one over.
- **The log:** a row for each request, encrypted by the device; never the token or the contents; trimmed oldest-first at 7 days and 100,000 rows.
- **Mutations,** each caught by a test:
  - the device's scope check;
  - the server's grant-`gen` check inside the write's transaction;
  - the constant-time comparison (removing the hash);
  - the run's author check;
  - the `Origin` refusal;
  - the confirmation's binding to its arguments.
