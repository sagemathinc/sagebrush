# The paired page: how an agent on this computer reaches the workspace

*Status: agreed between @sagebrush-board (the page) and @sagebrush-python (sagebrush-mcp), Oct 19, 2026. The design is design/workspace-files.md §8.2 (surface 2) and §8.7.*

**What this connects, before sync:**
- An agent running on the person's computer (Claude Code, Codex, or any MCP client) with `sagebrush-mcp`.
- The person's own open sagebrush.space page, where the workspace lives in the browser's IndexedDB.

The MCP server listens on the loopback address, and the page connects to it. One connection carries both:
- the workspace verbs (MCP tools such as `workspace_list`, `workspace_read`, …);
- the chat beside the document (§8.7).

The page alone decides what runs. It takes only allowlisted verbs, with arguments checked against `web/workspace/schema.json`, under the grant the person gave, and credits every change to the agent. It never evaluates anything it receives.

## 1. Where it works

- **Chrome:** an https page may open `ws://127.0.0.1`, because loopback counts as potentially trustworthy.
  - Chrome asks once per site ("Apps on device", Local Network Access, applied to WebSockets since Chrome 147). The answer can be revoked.
- **Firefox:** loopback is exempt from mixed content.
  - Firefox 154 asks the same way (Local Network Access for WebSockets).
- **Safari: not possible.** WebKit treats `ws://127.0.0.1` from an https page as mixed content (WebKit bug 171934 is still open).
  - The page says so plainly when it detects Safari or a failed connection: "Safari doesn't let a web page reach a program on this computer. Use Chrome or Firefox, or the Sagebrush desktop app." It never fails silently.
  - The desktop app has its own storage, so until sync it is a separate workspace.
  - After sync, the agent endpoint (§8.2, surface 3) works from any browser.

(Browser facts checked by @sagebrush-python on Oct 19; recheck them when a browser's policy changes.)

**What Chrome 149 actually did (measured Oct 30 against a deployed https preview, by @sagebrush-latex):**
- **The permission is "loopbackNetwork".**
  - While it is not granted, the socket fails with `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`, and the page sees only a closed WebSocket.
  - Granting `loopbackNetwork` lets pairing succeed. Granting `localNetworkAccess` or `localNetwork` does not.
  - `--disable-features=LocalNetworkAccessChecks` also lets it through (test runs only).
- **What the person sees:** the prompt reads "Chrome asks to let <site> access apps on this device". The page's failure copy should tell them to click Allow, and how to undo a Block in site settings.
- **No preflight is involved.** The server needs no `Access-Control-Allow-Private-Network` header, because a WebSocket is gated by the permission alone.
- **The page's own CSP must admit the socket.**
  - `connect-src … https: http:` does not cover `ws:`, so the policy lists `ws://127.0.0.1:* ws://localhost:*` explicitly.
  - Those are loopback only, in the page policy and the preview policy. The frame and runner policies are unchanged.
  - A CSP block looks the same to the page as a refused permission, so check the console for which one it is.

## 2. The connection

- **Address:** `ws://127.0.0.1:<port>/sagebrush`. The server binds 127.0.0.1 only.
- **The server checks:**
  - `Origin` is exactly `https://sagebrush.space`, plus one exact development origin when `SAGEBRUSH_MCP_DEV_ORIGIN` names it (off by default);
  - `Host` is `127.0.0.1:<port>` or `localhost:<port>` (against DNS rebinding).
- **Framing:** JSON-RPC 2.0, one message per WebSocket text frame, string ids, in both directions.
  - A frame is at most **12 MiB**: 8 MiB of binary content is about 10.7 MiB as base64, plus the JSON around it.
  - Each side checks the cap before parsing. A frame over it closes the socket with a reason.
- **Before pairing,** a message is at most **8 KiB** (the hello is a few hundred bytes); the 12 MiB cap applies only once the hello has paired.
- **The code** guards the port, since any local process can reach it:
  - 128 bits, shown as base32, by the agent and on the server's stderr;
  - single use, expires in 5 minutes, compared in constant time.

### 2.1 Hello

1. The person enters the code in the page: the Chat tab's "Connect an agent", or a `?pair=` link.
2. The page connects and sends the request
   `{"jsonrpc":"2.0","id":"p1","method":"hello","params":{"protocol":1,"code":"<code>","page":{"origin":"https://sagebrush.space","path":"/w/…"}}}`.
   - The code is case-insensitive.
   - There's no person id: before sync there is no account, and "the person" is whoever holds this browser. After sync, `params.account` comes from the session.
3. **On success** the server replies
   `{"protocol":1,"agent":{"name":"…","client":"claude-code"|"codex"|…,"version":"…"},"wants":{"folders"?:[…],"write":true,"run":false}}`.
   - The name is the agent's own claim. The page shows it as such: "Claude Code (as it says)".
4. **On refusal** the reply is error `{code:-32000, message, data:{code:"refused"|"protocol", message}}`, and the socket is closed with 1008 (refused) or 1002 (protocol).

**Reconnecting** ("Remember this agent"):
- **Who makes the secret:** the server, as 32 random bytes in base64url. It returns the secret as `session` in the result of a successful *code* hello. A session hello doesn't rotate it.
- **Where it is kept:**
  - the page keeps the secret itself, in the workspace's meta beside the grant (§2.2), and only if the person ticked "Remember this agent";
  - the server keeps only its SHA-256, in memory, for its own lifetime, so a restarted server needs a new code.
- **Reconnecting:** `hello` then carries `{"session":"<secret>"}` in place of `code`.

### 2.2 The grant comes before anything runs

After the hello, the page shows the person what the agent asks for (`wants`) and lets them choose:
- which folders;
- read, or read and write;
- may run code;
- for how long.

It then sends the notification `grant.changed` with the grant: `{agent, client, folders, write, run, expires}`. **No verb runs before that.** `grant.changed` with `{}` revokes the grant: the page closes the socket and forgets the session secret.

**Where the grant lives:** the page keeps it in `sagebrush-workspace`/meta under `grant:<pairing id>` (`{agent, client, folders, write, run, expires, created, lastUsed}`), and lists it in Agents with access (§8.4). The server never sends a grant, and never holds an authoritative one.

### 2.3 What the server also enforces

`sagebrush-mcp` (engine/py/python/sagebrush/pairing.py) is stricter than the steps above say. A page must respect these:

1. **One page at a time.** While a page is paired, another hello is refused: "another page is paired with this agent".
2. **A hello carries exactly one of `code` and `session`.** Both, or neither, is refused.
3. **Wrong guesses are limited:**
   - 5 wrong codes retire the code, and the agent must issue a new one;
   - 5 wrong session secrets make the server forget the session, and a new code is needed.
4. **After the hello, the page sends only notifications.** A page-to-server message with an `id` (a request) drops the connection. Notifications with other methods than those in this document are ignored.
5. **The handshake** must be `GET /sagebrush HTTP/1.1`, WebSocket version 13, with a valid 16-byte `Sec-WebSocket-Key`:
   - a repeated header (`Origin`, `Host`, …) gets a 400, and anything else wrong a 403, before any WebSocket;
   - the hello must arrive within 30 s of connecting;
   - at most 8 connections may be in their handshake or hello at once.
6. **Error codes the server makes itself,** besides the workspace's (`invalid`, `exists`, `missing`, `conflict`, `limit`, `storage`):
   - `timeout`: the page didn't answer a verb within 60 s;
   - `limit` with `retryAfterMs: 250`: 8 requests are already in flight;
   - `protocol`: the page's answer breaks the schema or the limits (over `maxList` or `maxHistory`, say).
7. **The grant is opaque to the server.** Any non-empty object counts as granted, and `{}` revokes. Folders, write, run and expiry are enforced by the page alone (§2.2, §3). So the page's grant-scoping is the only guard on what an agent may touch, and its tests carry that security.
8. **Frames** must follow RFC 6455 for clients:
   - masked;
   - no reserved bits or opcodes;
   - valid fragmentation;
   - strict JSON in UTF-8: no NaN or Infinity, no lone surrogates, no duplicate keys.

   A frame that breaks these closes the connection: 1002 for the framing, 1007 for the JSON, and 1009 for a message over the size caps (§2).

**Developing a page against the server:**
- **The server** is `sagebrush-mcp` (`sagebrush.mcp_server:main`).
- **`SAGEBRUSH_MCP_DEV_ORIGIN=http://localhost:<port>`** (or `http://127.0.0.1:<port>`) admits a page from that exact development origin, besides `https://sagebrush.space`. The server serves no page itself.
- **The code** comes from the agent's `workspace_connect` tool and is also printed on the server's stderr.
- **A reference fake page,** and the refusals above, are in engine/py/test_pairing.py.

## 3. The workspace verbs

**Server to page:** `{"id":"s<n>","method":"workspace.<verb>","params":{…}}`.
- **Paths** are checked on both sides against `schema.json`'s limits (`maxPath`, `maxDepth`, `maxName`). Neither side accepts NUL, lone surrogates, or NaN/Infinity in any value.
- **Answers** over `maxList` entries or `maxHistory` versions are a protocol error on the server's side.
- The verbs and their parameter schemas are in `web/workspace/schema.json` (written by `web/workspace/verbs.ts`): list, stat, read, write, create, mkdir, rename, duplicate, remove, restore, history, version.
- `sagebrush-mcp` makes its tools from that file. Tool names use underscores (`workspace_list`), because model APIs refuse dots.

**Contents on the wire:**
- a document (notebook or board) as `{json}`;
- a data file as `{text}` (UTF-8) or `{base64}`.

**Results:**
- list: `{entries, more?, cursor?}`, at most 10,000 entries per answer;
- stat and the changing verbs: `{entry}`;
- read: `{entry, rev, content}`;
- write: `{entry, rev}`;
- history: `{versions, more?, cursor?}`, at most 100 per answer;
- version: `{content}`.

**Errors:** `{code:-32000, message, data:{code, message, current?, retryAfterMs?}}`, where `data.code` is the workspace's: `invalid`, `exists`, `missing`, `conflict`, `limit` or `storage`.
- For a conflict, `current` is `{entry, rev, content}`.
- `sagebrush-mcp` returns errors to the agent as `isError` tool results.

**What the page enforces:**
- the grant: folders, write, run;
- the schema;
- the limits:
  - 8 MiB of content per call, refused with its size, never cut;
  - 8 requests in flight;
  - 100 per second, burst 200 (`limit` with `retryAfterMs`).

**What's never offered:** dropping versions, emptying Trash, forgetting entries. Only a person does those, in the page's own UI (§2.5, §8.2).

**Every change** is credited to `agent:<name>` in the operation log and in versions, and the page shows it ("Claude Code renamed …").

**Running code** (may run code, §8.3) comes later as `board.run` and `notebook.run`. They run in the page's runner, credited and logged, and only under a grant that allows it.

## 4. Chat on the same connection (§8.7, step 6)

**Page to server (notifications):**
- `chat.message`
  `{conversation, id, author, text, context:{path, kind, rev, selection:{cells?, items?, edges?}, page?, viewport?}}`
  - `conversation` is the chat document's path, for example `/Algebra/Sylow.chat`.
  - `author` is `person`, `collaborator:<id>`, and so on, set by the page from its session, never from the text.
  - The server delivers only messages that arrive on the paired socket.
- `chat.permission` `{request_id, behavior:"allow"|"deny"}`: the person's answer to a relayed prompt.
  - It is accepted only on the pairing the prompt was relayed to. After a reconnect, the page drops the prompts it showed before and sends no answers for them.

**Server to page (notifications):**
- `chat.reply` `{conversation, id, text, in_reply_to?}`: what the agent said (its `chat_reply` tool).
  - `id` is unique per pairing, so a page that reconnects doesn't write a reply twice.
  - The page writes the reply into the conversation document, credited to `agent:<name>`.
- `chat.permission_request` `{request_id, tool_name, description, input_preview}`: Claude Code's tool-approval prompt, relayed. The page shows Allow and Deny, and renders the text as text, never as HTML.
- `chat.delivery` `{conversation, id, via:"channel"|"chat_next"}`: the server handed the message to the agent.
  - This doesn't prove the agent read it: Claude Code drops channel events silently when the session didn't load the server as a channel.
  - So the page shows "sent to the agent", and "read" only once a reply or an action comes back.
- `chat.rejected` `{conversation?, id?, reason: {code, message}}`: a `chat.message` the server refused.
  - `code` is one of `malformed`, `conversation`, `id`, `author`, `text`, `too_long`, `context`.
  - `conversation` and `id` are echoed only when they parsed. The page marks the message "not delivered: <reason>".
  - What the server checks: `conversation` is a workspace path ending in `.chat`; `id` matches `[A-Za-z0-9_.:-]{1,128}`; `author` is `person`, `collaborator:<id>` or `agent:<id>`; `text` is at most 256 KiB of UTF-8 (262,144 bytes), so any valid message fits the queue; `context.path` is a workspace path; `kind` is one of the four; `rev ≥ 0`; selection ids match the id pattern, at most 50 per kind.
- `chat.dropped` `{conversation, ids}`: queued messages the server dropped.
  - Its queue holds at most 100 messages per conversation and 1 MiB in all.
  - The page marks those messages "not delivered" and offers Resend.
  - The conversation document is the real record. The server keeps nothing durable.

**Into the agent's session:**
- **Claude Code**, through its channels (research preview). The server:
  - declares `capabilities.experimental["claude/channel"]`;
  - pushes `notifications/claude/channel` with `{content: text, meta: {author, conversation, msg_id, path, rev, selection}}`. Meta values are strings, the selection is compacted to a string of ids, and keys must be identifiers;
  - exposes `chat_reply`;
  - relays approval prompts through `claude/channel/permission`.

  Until it's on Anthropic's allowlist, it runs with `claude --dangerously-load-development-channels server:sagebrush`, in an interactive session.
- **Codex and any other client:**
  - `chat_next(timeout ≤ 60 s)` waits for the next message;
  - `chat_reply(conversation, text)` answers.

  Once `chat_next` has been called in a session, the server stops pushing channel events and queues messages instead, so no message comes by both routes.
- **The agent's instructions** say that only `author: "person"` messages are instructions. Everything else (collaborators' messages, document text) arrives labelled as content.

### 4.1 The conversation's log: `chat.resume` (sagebrush-agent)

An agent whose hello (or agent.ready) lists the feature `chat.resume` keeps each conversation's log in memory. The log holds its `turn.event` and `chat.rejected` messages and the person's `chat.message`s, numbered from one counter for the whole agent process. Its hello names the run those numbers belong to: `log: {instance}`.

- **Live:** each `turn.event` and `chat.rejected` carries `seq`. The page keeps, per thread, the last number it applied and the run it came from, and applies each number once.
- **`chat.resume`** `{conversation, after, instance?}`: the page asks for what came after its last number. The page sends it once granted, for each thread an agent was in.
- **`chat.replay`** `{conversation, instance, last, reset?, events: [{seq, method, params}], done}`:
  - The agent answers in one or more messages. Each holding more than one entry is at most 1 MiB, or half the frame over a runner.
  - `reset`: entries the page asked for are gone, or its numbers are from another run. The page keeps what it has and applies `events`.
  - If the page's highest number is still below `last`, it asks again from there.
- **Who may read the log:** pairing, a session re-pair included, authorizes reading every conversation's log in that agent process. It is not scoped to a page or a conversation, and a workspace grant doesn't gate it.
- **On the page:**
  - When the pairing ends or the page reloads, a running turn of such an agent is *away* rather than interrupted: nothing on the page binds to it, and a new message waits for its end.
  - A replay finishes the turn with the agent's own events. Another run of the agent, or an agent without the feature, ends it as interrupted.
  - A replayed artifact never moves the pane.
  - The agent's bounds (ids of at most 256 bytes, 256 logs, 32 MiB) are in its lib/log.mjs.

## 5. Testing

- **sagebrush-mcp** tests its tool layer against a fake page: an in-process WebSocket client that implements the verbs over a dictionary.
- **The page** has a fake-server harness: a loopback WebSocket that pairs and sends verbs.
- **End to end,** in headless Chrome: a page pairs with the real server, and the tools act on its workspace.
- **Conformance:** both sides validate against `schema.json`. A test fails when the package's copy of the schema differs from the generated one.

## 6. Delegate tasks (`delegate.1`)

*Agreed Nov 21, 2026, between the agent side (sagebrush-agent) and the page; the security review cleared the design. A Delegate task is the agent's own copy of some documents, worked on and run on this computer by the agent, and proposed back as a diff; the person merges, closes, or asks for changes. The person's documents change only through the page's Merge: no method below writes the workspace.*

### 6.1 Requests, values and events
Every method, field, bound and error below is closed: anything not listed is refused (`bad_request`). Both sides validate against it, on the wire and on disk.

**Transport.** These are JSON-RPC 2.0 requests from the page to the agent; until now only the agent sent requests (§2, §4).
- **Request:** `{jsonrpc: "2.0", id: "p<n>", method, params}`.
  - `n` is a decimal counter, at most 2^53 − 1.
  - The `p` prefix keeps the page's ids apart from the agent's own.
- **Answer:** `{jsonrpc: "2.0", id, result}` or `{jsonrpc: "2.0", id, error: {code: -32000, message, data: {code: <one of the errors below>}}}`.
- **Bounds and failures:**
  - at most 8 pending page requests;
  - each `tasks.*` request, and each answer's raw frame as sent or received (UTF-8 bytes, the envelope and whitespace included), at most 4 MiB (4,194,304 bytes); over it, the receiver refuses it `too_large` before any of it is used. The pairing's other frames keep their own bound;
  - an answer to an unknown id is dropped;
  - every pending request is rejected when the socket closes;
  - the page's timeout is 30 s (120 s for `tasks.start` and `tasks.merged`).
- **Allowed only when** the hello's features list `delegate.1` **and** the pairing's grant holds `delegate: true` (§6.2). Otherwise every `tasks.*` is refused `forbidden`.
- `tasks.*` is refused on any transport but the loopback pairing in M1 (`unavailable`).
- `task.event` stays a notification from the agent.

**Values** (on the wire and on disk):

| Value | Rule |
|---|---|
| `task` | 32 lowercase hex |
| `commit` | 40 lowercase hex. A commit a request names (`tasks.diff`, `tasks.file`, `proposal` in a decision) must be this task's `base` or one of its stored proposal rounds (`refs/heads/base`, `refs/tags/round-<n>`), exactly: no other ref, no ancestor walk, no revision expression |
| `blob` | 40 lowercase hex. **A stored blob** (`base_blob`, `proposal_blob`, and `tasks.file`'s answer) must be exactly the blob at that path in that named base or proposal commit of this task. **A fresh blob** (`mine.blob`, `merged.blob` in `tasks.merged`) needs no reachability at all: the host checks `content`'s bounds, recomputes the hash of its bytes, and refuses unless they are equal (`bad_request`). A fresh hash is a check on the bytes sent with it, never a way to name or read any stored object |
| `path` | the path rules below; at most 2,000 per task |
| `kind` | `"notebook"` (path ends `.ipynb`) or `"file"` |
| `content` | a notebook: its `.ipynb` text (the page's `toIpynb`, with `metadata.sagebrush.seed`); a file: UTF-8 text, or `{base64}` for other bytes. A document is at most 4 MiB, all of a request's documents together at most 4 MiB. A document's `blob` is always the git blob id (SHA-1 of `blob <n>\0` + the bytes) of the UTF-8 bytes of `content`, or of the decoded bytes for `{base64}`; both sides check exactly that |
| `seq`, `round`, `qid`, `revision` | safe integers ≥ 0 (seq) or ≥ 1 (the others), only increasing |
| `merge_id`, `answer_id` | 32 lowercase hex, made by the page, kept across retries |
| `title` | ≤ 200 chars |
| `prompt`, `note` | ≤ 64 KB |
| answer `text` | ≤ 16 KB |
| `status` | `working`, `proposal`, `merged`, `closed`, `failed`, `interrupted` |

**Paths** (incoming documents, the agent's tools, and on disk):
- relative and normalized, with no `..` and no absolute paths;
- no drive, UNC or `:` (ADS) forms, and no reserved names (`CON`, `NUL`, `COM1`…);
- no component named `.git` (any case) or `.sagebrush`;
- no case collisions within a task;
- each component at most 255 bytes, each path at most 1,024.

**Errors** (`data.code`):
- `bad_request`
- `forbidden`
- `not_found`
- `stale` (the task moved past what the request names)
- `conflict` (a ref or state isn't as expected)
- `too_large`
- `busy` (a limit: running, queued, tasks kept, budget)
- `unavailable` (transport, platform, runner)
- `withdrawn`
- `final` (the task is merged, closed or failed)

**Requests:**

| Method | params | result | Checks |
|---|---|---|---|
| `tasks.start` | `{title, prompt, target: "local", run: bool, docs: [{path, kind, content}]}` | `{task, base, seq}` | `run` is frozen into the grant (§6.2); `run: true` is refused as `unavailable` when the runner is unavailable |
| `tasks.list` | `{}` | `{tasks: [{task, title, status, target, run, round, seq, proposal: commit\|null, question: bool, updated}]}` | at most 64 entries |
| `tasks.get` | `{task, after: seq}` | `{task: <list entry>, events: [{seq, event}], last: seq, reset: bool}` | events after `after`, at most 4 MiB per answer, so `last` may be short of the task's `seq`: a long log is read by repeating with `after = last` until `last` equals `task.seq`; `reset` when `after` is unknown |
| `tasks.diff` | `{task, commit}` | `{task, base, commit, round, seq, files: [{path, kind, change: "added"\|"modified"\|"deleted", base_blob: blob\|null, blob: blob\|null}]}` | `commit` is a proposal commit of this task, pinned by the caller; never "the latest" |
| `tasks.file` | `{task, commit, path}` | `{blob, content}` | the page checks that the git blob id of `content`'s bytes equals `blob` |
| `tasks.merged` | `{task, proposal: commit, seq, merge_id, files: [{path, kind, proposal_blob: blob\|null, mine: {blob, content}\|{absent: true}\|null, merged: {blob, content}\|{absent: true}\|null}]}` | `{recorded: "merge"\|"receipt", commit: commit\|null}` | `proposal` and `seq` current, or `stale`; `files` names exactly the paths the proposal changed (`tasks.diff` of that commit), each `proposal_blob` as there: `null` exactly for a path the proposal deletes; idempotent by the exact request (below); the outcomes below |
| `tasks.close` | `{task, proposal: commit\|null, seq}` | `{status}` | `stale` if moved |
| `tasks.ask` | `{task, proposal: commit, seq, note, current: [{path, kind, content}]}` | `{status, round}` | `stale` if moved; `current` only the task's own paths |
| `tasks.stop` | `{task}` | `{status}` | stops the turn and the run; the task becomes `interrupted` |
| `tasks.revoke` | `{task}` | `{status}` | `closed`; the grant is void, and queued work is dropped |
| `tasks.resume` | `{task, note?}` | `{status}` | only from `interrupted`, with the frozen grant; `note` (0.8.13): text of at most 64 KiB, for the resumed turn only |
| `tasks.answer` (M2) | `{task, qid, revision, answer_id, text}` | `{accepted: bool, current: bool}` | §6.4 |

**`tasks.merged`'s two outcomes:**
- **Idempotency binds the exact request.** The host keeps, per `merge_id`, the SHA-256 of the request's canonical JSON (keys sorted) and the answer it gave.
  - The same `merge_id` with the same bytes (a retry after a lost ack) gets the same answer, and nothing is recorded twice.
  - The same `merge_id` with any other payload is refused `conflict`.
  - A new `merge_id` for a task that already recorded a merge is refused `final`.
- **`proposal_blob: null`** means the proposal deletes that path. Its `merged` is then `{absent: true}` if the person took the deletion, or `{blob, content}` if they kept their file, and its `mine` is what the page reports: bytes, `{absent: true}`, or `null`.
- **`{absent: true}` is full information.** The file isn't on that side: the person deleted it since the base (`mine`), or the merge removes it (`merged`). The commit then simply leaves it out.
- **`merge`:** every file's `mine` and `merged` is either its full bytes or `{absent: true}`. The host builds `mine-<n>` and the merge commit from exactly that, as reported.
- **`receipt`:** when any `mine` or `merged` is `null` ("not sent"), or for remote targets. A metadata-only record (the hashes, and "content not sent"), **never** a commit labeled as the merge.

**Events (`task.event {task, seq, event}`):**
- the chat turn events (as `agent-chat/events.ts`), and:
- `{type: "task_status", status, reason?}`;
- `{type: "proposal", round, base, commit, files}`, with files as in `tasks.diff`;
- **M2:**
  - `{type: "question", qid, revision, text, blocking, choices?}`;
  - `{type: "question_withdrawn", qid, revision}`;
  - `{type: "question_answered", qid, revision, answer_id, current}`.

### 6.2 Authority: the Delegate switch, a task's grant, and who may act
- **Delegate is its own capability, granted explicitly.** A pairing doesn't get it by being a pairing.
  - The page's grant gains `delegate: true` only when the person turns on "Allow Delegate tasks on this computer" in the pairing screen. The scope is that agent installation's tasks.
  - **The switch is disclosed as what it is:** it lets this page read every existing Delegate task of this installation, and make the person's decisions on them (Merge recording, Close, Ask, Stop, Revoke, Resume).
  - **It is checked on every `tasks.*` call.**
  - **Turning it off** (a grant change without it, or a revoke of the pairing) does two things at once:
    - **it revokes the pairing's Delegate capability immediately:** that pairing can't start, list, read or decide any task;
    - **it stops every active and queued Delegate turn and run** of the installation that the switch had allowed, and they become `interrupted`, not closed.
  - **Closing tasks for good is a separate, explicit choice:** `tasks.revoke` per task, or a "Close all tasks" action the page offers beside the switch. Closing tasks never leaves the authority to start new ones active, and turning the switch off never closes a task by itself.
  - A pairing without it gets no `tasks.*` and sees no tasks.
  - Pair grants are unchanged.
- **A task's grant is frozen at `tasks.start`:** `{docs: [paths], run: bool, scope: <installation id>, created}`.
  - The host validates it, and records it in its control state and in the task's first (base) commit, which is immutable; control state that disagrees with the base commit makes the task `failed`.
  - Closing a tab doesn't revoke it, and no reconnect, resume or later Pair grant widens or changes it.
  - `tasks.revoke` voids it.
  - The agent's model can't write the control state, and nothing in the task's working copy is read as authority.
- **Statuses and transitions:**
  - `working -> proposal | failed | interrupted | closed`;
  - `proposal -> working` (Ask) `| merged | closed`;
  - `interrupted -> working` (resume) `| closed`;
  - `question` is a flag on `working`, not a state.
  - Each transition is checked and written atomically: the host records its intent first, and finishes or drops it after a crash.
  - `merged`, `closed` and `failed` are final.
- **Person-only decisions** (merged, close, ask, answer, resume, stop, revoke) are pairing requests, never model tools.

### 6.3 What M1 offers
- Target `local` only, over the loopback pairing only: every `tasks.*` is refused `unavailable` on any other transport.
- `tasks.answer` and the question events are defined here (§6.4) and come in M2.

### 6.4 Questions
- `ask_person` returns a `qid`. Each question has a `revision`, from 1 and only increasing.
  - `revise_question` adds a revision, keeping every earlier wording.
  - `withdraw_question` sets `withdrawn`, which is final.
- **An answer names `{task, qid, revision, answer_id}`.** The text is at most 16 KB, and it is accepted at most once per `answer_id`.
  - An answer to the current revision satisfies it.
  - An answer to an older revision is recorded, and the agent is told, labeled: "answered revision N; the question is now revision M". **It never satisfies a revised blocking question**, which keeps waiting.
  - An answer to a withdrawn question is refused (`withdrawn`), and never reinstates it.
- Questions and answers are content, never permission or execution approvals.
