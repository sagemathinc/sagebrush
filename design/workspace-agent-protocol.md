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

## 5. Testing

- **sagebrush-mcp** tests its tool layer against a fake page: an in-process WebSocket client that implements the verbs over a dictionary.
- **The page** has a fake-server harness: a loopback WebSocket that pairs and sends verbs.
- **End to end,** in headless Chrome: a page pairs with the real server, and the tools act on its workspace.
- **Conformance:** both sides validate against `schema.json`. A test fails when the package's copy of the schema differs from the generated one.
