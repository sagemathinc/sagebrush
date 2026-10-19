# The agent endpoint: agents in a synced workspace

*Status: design, for review by astra (correctness), daybreak2 (limits) and William. Not built yet. When built, it stays behind the sync service's flag, which is off in production (design/sync-server.md §11).*

This is design/workspace-files.md §8.2's third surface, "Anywhere, with sync", together with §8.4's grants and access log. With it, a person's own agent (Claude Code or Codex on any computer, or an agent in a cocalc.ai project) can work in their workspace through the workspace API's verbs while every device of theirs is closed. It is built on the sync server (design/sync-server.md), and the account object holds everything here.

**What it is not:**
- **It runs no code.** A run is relayed to an open page of the person's, and happens there in the runner (§6). With no page open, a run is refused.
- **It is not the in-page surface** (`window.sagebrush.workspace`) and not the local MCP adapter. Those act with the page's authority (§9.2).

---

## 1. The grant

A grant is made by a person to one agent. Its fields:

```
grants(
  id            12 base32 chars, random
  agent         the agent's name as the person sees it ("Claude Code on laptop", "cocalc: number-theory/claude")
  token_hash    SHA-256 of the token's secret
  scopes        JSON: [{path, access: "read" | "write"}], at most 32
  run_code      0 | 1           "may run code" (§6)
  outward       JSON: the outward actions granted beforehand, [] by default (§5)
  rate          JSON: this grant's limits (§7), at or below the defaults
  created, expires, last_used, revoked, revoked_reason
)
```

- **Scope** is a list of folders or files, each read or read-and-write.
  - A path covers itself and everything under it, matched on whole segments, so `/Algebra` doesn't cover `/Algebra2`.
  - Paths are normalized by the same `normPath` the client uses, with its tests.
  - `/` is the whole workspace, and the grant dialog says so plainly.
- **Trash:**
  - an agent with write access may `remove` within its scope, which moves an entry to `/Trash/`, and `restore` what was removed from its scope;
  - it sees only the Trash entries that came from its scope (`trashed_from`);
  - no verb empties Trash (§8.2).
- **Expiry:** 30 days by default, and at most 90. It is shown, and can be extended only by the person.
- **At most 50 live grants per account.** The person revokes one to make another.

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
     - `wants.scopes` at most 32 paths, each checked by `normPath`.
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

**Then every request, in this order, inside the account object:**
1. The grant exists, isn't revoked or expired, its secret matches, and the account is `active` (or `readonly`, for reads). On dev, the account must also be in `SYNC_ACCOUNTS` (design/sync-server.md §11).
2. The grant's rate limits, and then the account's (§7).
3. The verb's paths are inside the scope, with the access the verb needs (read, or write).
4. The verb runs.
   - **A write to the index** (an op) is one transaction in the account object. The grant is checked again in it, so a revoke that lands while the request runs prevents the write.
   - **A write to a document** is admitted, and then fenced if it must be (design/sync-server.md §4.5):
     - the account object checks the grant and scope, and records an admission, in one transaction;
     - the document object commits it only if it isn't fenced and hasn't expired (60 seconds);
     - a revoke, a narrowed scope or a rename out of scope cancels pending admissions, and completes only once they are fenced or expired.
     - So no write admitted before a revoke commits after the revoke completes.
5. A row is written to the access log (§8), in the same transaction as the write or the admission. A document write's row is then marked `committed` or `refused` when its answer comes.

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

| Verb | Access | How it is done on the server |
|---|---|---|
| `list`, `stat` | read | from `entries` (design/sync-server.md §3), filtered to the scope |
| `read` | read | a data file: a signed URL (design/sync-server.md §5.4). A document: its current value (below) |
| `write(path, content, {base})` | write | a data file: blob, then op, with compare-and-swap on its `sha256`. A document: a patch (below) |
| `create`, `mkdir` | write (the parent) | an op, credited to `agent:<name>` |
| `rename`, `duplicate` | write (both paths) | an op |
| `remove`, `restore` | write | an op (to Trash and back) |
| `history`, `version` | read | a document's batches; a data file's versions |
| `watch(path)` | read | on the socket: the ops and `changed` within the scope |
| `run(path, cell or note)` | write and `run_code` | relayed to a page (§6) |
| `chat.next`, `chat.reply` | the chat document's access | §8.7's remote adapter: messages are patches on a `.chat` document |

- **Not verbs:** emptying Trash, clearing a history, dropping versions, making or changing grants, deleting synced data. Only a person, from a session, may do these (§8.2, §8.3).
- **Ops and patches from a grant are credited:** `by: "agent:<name>"`, device `grant:<id>`, and author `agent:<name>` on each patch. The server sets these from the grant, never from the request.

**Documents on the server.** Notebooks, boards and chats are patchflow logs, opaque to the sync objects (design/sync-server.md §10). The agent endpoint is the one place that reads them:
- `read` and `write` on a document run in the Worker, in `web/sync/agent-docs.ts`, which uses the same patchflow codecs as the pages (web/notebook/history.js, web/board/history.ts);
- it reads the latest snapshot and the batches since (design/sync-server.md §5.2 `pull`), and computes the value;
- for `write`, it makes the patch from `base` to the new value, and sends it as a one-patch batch with `expect_head` set to the head it read (design/sync-server.md §4.4), from the grant's own patchflow client (`grant:<id>`), credited to the agent;
- **its bounds:** documents up to 8 MB of value, and 2,000 batches since the snapshot. Beyond either, it answers 413 `limit`, and suggests opening the page;
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

## 6. Running code

**A remote agent's runs happen only in an open page of the person's** (§8.3). The server has no compute.

- **`run` needs `run_code`** on the grant, and write access to the document.
- **The relay:**
  - the account object picks a page that is connected on the account socket, says it accepts relayed runs (it has the document's interpreter available), and has had the person's input within the last 12 hours;
  - it sends the page `{t: "run", run_id, grant, agent, path, target, code_sha256}`;
  - with no such page, it answers 409 `no_page`, and never queues a run.
- **The page checks again before running,** from its own copy of the grant, which it gets over the account socket:
  - the grant still allows running in that path;
  - **the code is the agent's own** (§8.3, "code that agent wrote"): the cell's or note's current input was last changed by a patch authored by this grant's agent, and its SHA-256 is `code_sha256`. Code that another person or agent last changed is not this agent's to run. The agent can rewrite it, which makes it the agent's own, credited to it and visible in TimeTravel;
  - the run happens in the runner, never in the fallback worker (§8.3, danger 2). If the runner isn't available, it is refused with `runner_unavailable`.
- **The person sees it:** a running indicator naming the agent, with Stop, and an entry in the conversation or the document's history.
- **The result** is the run's outputs, bounded as the page bounds them (design/security.md rules 1-4). It goes back through the account object to the agent, and is logged with the code's hash.
- **Revoking reaches a running run** (§8.9 question 3):
  - turning off `run_code`, or revoking the grant, sends `{t: "grant", id, run_code: false}` or `{t: "revoked", grant}` to every page of the account;
  - a page stops that grant's runs at once, by the runner's Stop;
  - a page that missed the message refuses at its next check, because every relayed run carries the grant's state from the account object, which is the only source of truth.

## 7. Limits, sizes and rates

For daybreak2. Every limit is per grant, inside the account's own limits (design/sync-server.md §8), which bound all grants together. The numbers are first values.

| What | Per grant |
|---|---|
| Requests | 60 a minute, 1,000 an hour |
| Read | 200 MB a day of bytes **authorized**: a signed URL debits the blob's whole size when it is issued, and a document read debits its value's size. A grant's URL is used once (design/sync-server.md §5.4), so the bytes it can transfer are at most what was debited. |
| Written | 100 MB a day; each write at most 32 MB (larger: as a blob, at most `max_file_bytes`) |
| `list` | 1,000 entries a page, at most 10,000 in a call |
| Document reads and writes | 8 MB of value; 2,000 batches since the snapshot (§4) |
| Runs | 1 at a time, 60 an hour; each bounded by the runner's own time and memory limits |
| Sockets | 2 |
| Confirmations waiting | 5 |
| Pairings | §2: 3 pending per IP and 10,000 site-wide; 10 made an hour per IP; polls every 5 s at most, 150 per pairing, 60 a minute per IP; 5 approved and waiting per account |
| Before authentication | 60 requests a minute per IP, 10 that fail (design/sync-server.md §2) |

- **What an agent over a limit sees:**
  - 429 with `{error: "rate", limit: "requests_per_minute", retry_after}`;
  - or 413 with `{error: "limit", limit: "write_bytes", max}`.
- **Nothing is half done:** every check comes before any write.

## 8. The access log

- **One row per request,** in the account object: time, grant, agent, verb, path (or paths), result, bytes, and for a run, the code's SHA-256. A request's arguments and contents are never logged.
- **Kept for 90 days, and at most 100,000 rows per account.** The oldest go first.
- **Who may read it:** the person, in "Agents with access", per grant or all together. An agent can't read the log, its own entries included.
- **It is the person's data.** It is deleted with their synced data, by "Delete my synced data" and by the purge (design/sync-server.md §7). Sagebrush's operators have no view of it.
- **"Undo this agent's changes"** uses TimeTravel's attribution, which every op and patch carries (§4), not the log. The log says what an agent asked for, and the history what it changed.

## 9. Answers to design/workspace-files.md §8.9

1. **How tokens are issued, stored and rotated.**
   - Issued by the person on sagebrush.space, by pairing or from the grant dialog (§2).
   - Stored only as a SHA-256, in the account object.
   - Rotated by the person, and the old one stops at once. There are no refresh tokens, and expiry is at most 90 days.
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
   - **Retention:** a write that can't keep the previous version is refused, on the server as on the client (design/sync-server.md §13). Filling the quota on purpose therefore blocks writes, and loses nothing.
4. **Rates and sizes per verb:** §7. An over-limit agent sees 429 or 413, with which limit it hit and when to retry.
5. **The access log:** 90 days and 100,000 rows. Readable by the person only (§8).
6. **The Inbox.**
   - **Who may send:**
     - the person's own grants with `outward.inbox` (their cocalc.ai agents);
     - accounts the person has allowed by name.
     - Nobody else, so the Inbox can't be used to spam.
   - **Size limits:** each item at most 50 MB; 100 items waiting at once; 20 a day from one sender.
   - **An item is a read-only entry under `/Inbox/`.** Its code never runs, as with a shared collection.
   - **Accepting it** moves it into the workspace as the person's own copy. Its origin (who sent it, when) is kept on the entry. It is still never run by itself: the person runs it.
   - **Declining it** deletes it.
7. **A collaborator's grant and the owner's files.**
   - A grant covers only what the granting account owns, or may edit as a collaborator. It is checked against the document object's access list for that account, every time.
   - When an owner removes a collaborator, the collaborator's grants lose that document at once, because the next check fails.
   - The owner sees, in the document's access list, which agents have reached it through a collaborator's grant. Each is listed with the collaborator who granted it, and the owner can remove that access.

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
- **Grants:**
  - a token for another account, a wrong secret, an expired grant and a revoked grant each give the same 401;
  - a revoke while a write is running prevents the write;
  - revoking closes the grant's sockets;
  - a pairing is used once, by the holder of its secret only, and a wrong code fails 5 times and then the pairing ends.
- **Scope:**
  - `/Algebra` doesn't cover `/Algebra2`;
  - `..`, `.`, `//` and other spellings normalize to the same path, or are refused;
  - a rename out of scope is refused;
  - Trash shows only what came from the scope.
- **Person-only verbs** (emptying Trash, clearing a history, dropping versions, granting, deleting synced data) are refused for every grant.
- **Outward actions** need a confirmation, or a scope given beforehand. A confirmation covers exactly one action, with those arguments.
- **Runs:**
  - refused without `run_code`, without a page, and for code the agent didn't last change;
  - refused when the runner isn't there;
  - stopped when the grant is revoked.
- **Limits:** each row of §7, at the limit and one over.
- **The log:** a row for each request; never the token or the contents; trimmed at 100,000 rows.
- **Mutations,** each caught by a test:
  - the scope check;
  - the recheck inside the write's transaction;
  - the constant-time comparison (removing the hash);
  - the run's author check;
  - the `Origin` refusal;
  - the confirmation's binding to its arguments.
