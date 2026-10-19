# A board's host: showing a board and taking its answers

A *host* is a page that shows a board to its user and passes what the user
answers back to whoever made the board. The first host will be CoCalc's
chat artifact card. It shows a `.board.json` file an agent published, and
gives the user's answers to the agent: as guidance to its turn if one is
running, else as a new turn (see Delivery). This file is the contract
between such a host and the board. design/frame.md covers the frame itself:
what it is, its sandbox, and showing a board without answers.

## The loop

1. An agent writes a board. One of its pages asks the user things: items of
   `kind: "ask"` (web/board-format.md).
2. The host embeds `https://sagebrush.space/frame/board/` in a new iframe,
   with a nonce in its address (see The bootstrap). When that frame says
   `ready` with the nonce, the host posts it the board with a `revision` of
   its own (for example the artifact's version) and one end of a new
   `MessageChannel`.
3. The user answers with the board's controls and presses **Submit**. The
   frame sends the page's answers over that channel.
4. The host checks the submission against the board it posted on that
   channel. It then gives the submission to the agent as data the user
   submitted: as guidance to the agent's running turn, or, if none is
   running, as a new turn.
5. The agent records the answers in the file
   (`sb board answers FILE --apply SUBMISSION.json`), updates the board,
   and publishes it again. The host shows the new board in a new frame, with
   a new nonce and a new channel, and the user sees it.

## The channel

Answers travel only over a `MessageChannel` that belongs to one board in
one load of the frame:

- The host makes a new channel for each `board` message it posts. It
  transfers `port2` with that message and keeps `port1`. On the same `port1`
  it keeps the board it posted: its text, or at least its questions. That
  board is what the channel's submissions are checked against.
- The frame takes a port only with a `board` message from `window.parent`.
  It sends `answers` only on that port, and accepts `received` and
  `refused` only from it.
- Each board has a frame of its own. The host doesn't post a second board
  to a frame: it shows the new board in a new frame, and closes the old
  `port1`. (A host that grants editing sends the board's changes on the
  channel instead: see Editing.) (A second `board` message would make the frame reload, as
  design/frame.md says. The reloaded document has no nonce, so it gets no
  port.)

The channel is what binds a submission to the frame document the host gave
the board to. `e.source === iframe.contentWindow` only names a browsing
context. A `WindowProxy` stays the same when the frame is navigated to
another document, and that document could post from it, but it never had
the port. The host still checks the source of every window message it acts
on (`ready`), but takes answers only from the port.

## The bootstrap: which document gets a port

A `ready` from the frame's window doesn't show which document sent it. A
document the frame was navigated to sends from the same `WindowProxy`.
Nor does the origin show it: the frame's page sandboxes itself (its
Content-Security-Policy, design/frame.md), so its origin is opaque and
`event.origin` is `"null"`, however it is embedded. So the host grants a
port only to the document it loaded the frame with, and only once:

- **A nonce in the address.** For each board the host makes a new iframe
  element and loads `https://sagebrush.space/frame/board/#sb-nonce=N`.
  `N` is `crypto.randomUUID()` (122 random bits), made for that element
  and never used again.
  - A fragment is not sent to the server, nor in a `Referer`.
  - The frame reads the nonce when it starts, removes it from its address,
    and sends it in its first `ready`.
  - A document the frame is navigated to was never given the nonce, and
    the board's code runs in a nested frame of another origin, which can't
    read it.
- **Once per element.** The host answers the first `ready` that has the
  element's nonce, from that element's window, with the board and a port,
  and no other `ready` after that.
- **One load per element.** The host counts the element's `load` events.
  A second one means another document is in the frame, which the host
  didn't load. The host then closes the channel and grants nothing more.
  To go on, it shows the board in a new frame.

A host that gives no nonce gets no Submit: the frame shows the board, and
the host posts it no port.

A host that posts a board without a port gets the board shown without
Submit. Showing a board needs no channel.

## The messages

All messages are objects with a `sagebrush` field naming the message and
`version: 1`. A receiver drops messages with another `version`, and fields
it doesn't know.

On the window (`postMessage` to `window.parent`, or to the frame's
`contentWindow`):

- From the frame: `{ sagebrush: "ready", version: 1, nonce? }`. The frame
  listens. `nonce` is the one in the address the frame was loaded with (see
  The bootstrap), in its first `ready` only.
- From the frame: `{ sagebrush: "error", version: 1, message }`. A posted
  text isn't a board; the board shown stays.
- From the host: `{ sagebrush: "board", version: 1, text, name?, revision?, edit? }`,
  with the transferred port. `revision` is any string up to 200 characters,
  which the frame only echoes back. `edit: true` (with a `revision`) grants
  editing (see Editing).

On the channel:

- From the frame: `{ sagebrush: "answers", version: 1, id, name, revision, page, answers, notes, comment }`.
  - `id`: `crypto.randomUUID()`, made when the user presses Submit with
    answers not sent before. A press that sends again (see Once) reuses it.
  - `name`, `revision`: as posted in `board`, or `null`.
  - `page`: `{ number, id?, title? }`. `number` counts pages from 1, as `#p2`
    does in the board format.
  - `answers`: an object. It maps the id of each ask item on that page that
    has an answer to its answer, in the shape of the item's input
    (web/board-format.md). Unanswered items are left out. Submit can't be
    pressed while a `required` item is unanswered.
  - `notes`: an object. It maps the id of each ask item on that page that
    the user answered in their own words to those words. Every question
    offers this, beside its controls or in place of them. A question with a
    note and no answer counts as answered: `required` is met. Questions
    without a note are left out.
  - `comment`: the text of the Submit bar's comment field, possibly `""`.
- From the host: `{ sagebrush: "received", version: 1, id }`. The submission
  `id` was durably delivered to the agent, as guidance or as a turn (see
  Delivery and Once); the frame shows "Received".
- From the host: `{ sagebrush: "refused", version: 1, id, message }`. The
  submission `id` was refused; the frame shows `message` and lets the user
  change the answers and submit again.

The frame acts on `received` or `refused` only for the `id` it is waiting
for.

## Checking a submission

Before anything else, the host checks the whole message. It answers
`refused` to one that fails any check, and passes nothing of it on. Each
check is against the board posted on that channel, so a stale submission is
checked against the board it was made from, never the current one.

- It is plain JSON data. Only objects whose prototype is `Object.prototype`
  or `null`, arrays, strings, finite numbers, `true`, `false` and `null` are
  allowed: no `Map`, `Date`, typed array, `Blob` or anything else structured
  clone can carry. Nesting is at most 4 deep.
  - Check the types first, by walking the message without recursion and
    with a counter. Structured clone can deliver cycles, and
    `JSON.stringify` throws on them.
  - Then check the size: at most **64 KiB as UTF-8**, which is
    `new TextEncoder().encode(JSON.stringify(m)).length <= 65536`. Run it
    inside `try`.
- The fields, exactly:

| field | rule |
|---|---|
| `sagebrush`, `version` | `"answers"`, `1` |
| `id` | a UUID (36 characters, `8-4-4-4-12` hexadecimal) |
| `name`, `revision` | equal to what was posted on this channel (`null` if nothing was) |
| `page.number` | a whole number, a page of that board; `page.id` and `page.title` that page's, if given |
| `answers`, `notes` | each at most 200 keys, each the id of an ask item on that page |
| each answer | the item's shape: `check` a list of at most 100 distinct values of its options (`true` or `false` without options); `radio` and `choice` one value of its options; `text` a string; `number` a number within its `min`/`max` and on its `step`; `scale` a whole number from its `min` to its `max` |
| a text answer, a note, `comment` | strings of at most 10,000 characters |
| required items | each has an answer, or a note that is not only spaces |

- Fields other than these are dropped, not passed on.

Sagebrush provides the check as a function of the board's text and the
message, so that every host checks the same way. It goes in the
`sagebrush-board` package, built with the Submit bar.

## Deciding

A question can list what the reader's own words may show, in its `decide`
(web/board-format.md): self-describing names such as
`confuses-transitive-with-two-transitive`, each with an optional `about`
that makes it clearer and an optional `next`, the item to go to. When the
reader explains in their own words, the frame can ask the host which of
these the words show. The host asks a model it chooses, and answers. The
board then shows that option's `next` at once.

A decision is not a submission. It goes to no agent and starts no turn.
The frame keeps it, like an unsent answer, only while it is open. The reader's words still
reach the agent only by Submit, as the question's note. The host may add
its own record of what it decided, which it doesn't need the frame to tell
it.

On the channel:

- From the frame: `{ sagebrush: "decide", version: 1, id, name, revision, page, item, note }`.
  - `id`: `crypto.randomUUID()`, new for each request.
  - `name`, `revision`, `page`: as in `answers`.
  - `item`: the id of a question on that page that has a `decide`.
  - `note`: the reader's words, at most 10,000 characters, not only spaces:
    the question's note, or the answer of a `text` question.
- From the host: `{ sagebrush: "decided", version: 1, id, option }`.
  `option` is the `name` of one of the question's `decide` entries, or
  `null` when none of them fits.
- From the host: `{ sagebrush: "refused", version: 1, id, message }`, as for
  a submission: the frame shows `message`.

The host checks a request as it checks a submission: plain JSON data, at
most 64 KiB and nested at most 4 deep, `name` and `revision` those posted on
the channel, `page` a page of that board, `item` a question of that page
with a `decide` that `sagebrush board check` accepts. **The question and its
options come from the board posted on that channel, never from the
message.** Only `note` is the frame's. A host that can no longer read the exact board it
posted (for example, one pinned by its SHA-256) refuses: it never decides
against another version. Sagebrush provides this check as
`decideRequest(posted, message)` in `sagebrush-board/submission`. It returns
`{ ok: true, request: { id, name, revision, page, item, prompt, options, answer } }`,
where `prompt` is the question's title and text (Markdown), `options` is
`[{ name, about? }]`, and `answer` is the note. Otherwise it returns
`{ ok: false, id?, message }`. Every host then asks its model the same
thing.

The host's model reads the reader's words as data, not instructions: the
words decide among the options and do nothing else. The host answers only
with a name from `options`, or `null`. The host limits how often requests
may be made, per channel or per user and board, whichever it can see, and
bounds the total rate it serves. A request costs the user's allowance, so the frame sends one only when
the reader asks for it.

## Delivery

A submission goes to the agent that published the board, in the thread
where it published it:

- **A turn of that agent is running** in the thread: the host delivers the
  submission to it as guidance (in CoCalc, a message steering the running
  turn). The turn goes on, now with the answers. Turns can be long, and an
  agent takes guidance well.
- **No turn is running:** the host starts one, with the submission as its
  message.
- **Racing the end of a turn:** if the turn ends while the host is
  delivering to it, the delivery is as one of the two, never both and
  never neither. The service decides, under the submission's idempotency
  key (see Once).

Either way the delivery is the "admission" of Once: `received` means the
guidance, or the new turn, was saved durably. The submission `id` is the
idempotency key of that delivery at the service, whichever kind it is. A
submission sent again therefore can't be delivered twice, as guidance or
as a turn.

## The host's duties

- **Whose data.** The user pressed Submit and chose or typed the answers.
  Everything else in a submission came from the board, which an agent may
  have written: the option values, the page's title and the question ids.
  The whole submission is untrusted data, quoted to the agent as data. It
  is not an instruction from the host, and not an approval of anything
  outside the board. Nothing runs because of it.
- **Staleness.** When the channel's `revision` is not the artifact's current
  one, the host says so with the submission ("answers to an earlier
  version of the board"). It has already checked the submission against
  that earlier board, and it lets the agent decide.
- **Once.**
  - The frame disables Submit in the same click handler that sends the
    message, before it returns. It stays disabled until `received` or
    `refused` names that `id`.
  - With no answer in 30 seconds, the frame offers "Send again", which
    sends the same `id`. Changing an answer after `refused` makes a new
    `id` on the next press.
  - The host marks an `id` *pending* synchronously, when the message
    arrives, before any asynchronous step. A repeat of a pending `id` is
    ignored: the first one's outcome answers both.
  - `received` means the delivery (see Delivery: guidance to a running
    turn, or a new turn) was admitted durably (in CoCalc, the message
    saved), not that the message arrived. The host awaits
    that admission, then marks the `id` taken and sends `received`. It
    answers a repeat of a taken `id` with `received` again.
  - When admission definitely fails, the host forgets the pending `id` and
    sends `refused` with the reason. The user can send again with the same
    `id`.
  - When the outcome is unknown (a timeout, a lost connection), the host
    asks the service with the `id` before it answers. The submission `id`
    is the idempotency key of its delivery, at the service and not only in
    the page. So a submission sent again after a reload or from another tab
    can't be delivered a second time, as guidance or as a turn.
  - Each channel has its own board, pending ids and taken ids. A handler
    still running when a new board replaces its channel sees and changes
    only its own; its reply goes to its closed port and is lost.
  - A `refused` message is the host's own words, at most 500 characters:
    never an exception's text as it is.
  - The host keeps at most 100 ids per channel and refuses submissions
    past that. The ids go when the channel is closed; the service's keys
    last as long as its own idempotency window.
- **Unsent answers.** The frame keeps nothing: it has no storage. Posting a
  new board restarts the frame, and answers not yet submitted are lost. So
  post a new board only when the agent has published one, and preferably
  not while the user is typing.

## Editing: a host that saves the board

A host can also let the user edit the board in the frame. CoCalc's card
does this; its full editor (a registered `.board.json` editor) uses the
same model. **The frame never writes the file. The host owns saving**: it
merges each edit into its own document (in CoCalc, the syncdb, as
design/board-cocalc-adapter.md design B describes) and decides when that
reaches the file.

### The model: records and their changes

A board is records keyed by `(type, page, id)`, as in web/board/history.ts:

| key | the record |
|---|---|
| `{type: "doc", page: "", id: ""}` | the title, language, links' base, pictures' sizes; without pages, its intro, layout and tour; `paged: true` if it has pages |
| `{type: "page", page, id: ""}` | a page: `pos`, title, intro, layout, tour |
| `{type: "item", page, id}` | a note or a group: `parent` (`""` at the top), `pos` among its siblings, and its fields (`x`, `y` among them) |
| `{type: "edge", page, id}` | `from`, `to`, `pos`, `label`, `arrows`, `line` (its `id` is the JSON of its ends and which of those it is) |

The string columns (`title`, `text`, `code`, `detail`, `label`, `intro`) are
text: the host's merge keeps both people's typing in one field, as in a
notebook. `toRecords` and `fromRecords` (web/board/history.ts) turn a board
into its records and back, and both sides use them.

**A change** says what the user changed *and what they changed it from*,
so that the host can merge it into whatever its document has become since
(see Merging):

- `{ op: "set", key: {type, page, id}, fields: {…}, was: {…}, create?, record? }`
  - `fields`: the new values of the fields changed. A field set to `null`
    is removed. `fields` never holds `type`, `page` or `id`.
  - `was`: for each field in `fields`, the value the user saw before the
    change (`null` if the record didn't have it).
  - `create: true`: the record didn't exist where the user made it. `was`
    is then empty, and `fields` holds the whole record.
  - `record`: the whole record after the change, given when the change
    touches a text column of an existing record (see Merging: an edit to a
    record deleted elsewhere).
- `{ op: "delete", key: {type, page, id}, was: {…} }`: the record is
  removed. `was` holds its text columns as the user saw them. Deleting an
  item doesn't delete its children or edges by itself. The edit lists each
  record it removes or moves, and the result must be a board (see The
  checks).

A list of changes is applied in order, as one step: all of it or none of
it.

### Granting it

The host grants editing in the `board` message it posts with the port:
`{ sagebrush: "board", version: 1, text, name?, revision, edit: true }`.

- `revision` is required when `edit` is given. It names the state of the
  document posted: any string of at most 200 characters, a new one for each
  state the host sends (see Revisions).
- **Only a board of at most 8 MiB** of JSON is editable in a frame. A
  larger one is posted without `edit`, and is shown read-only, with the
  host's own editor offered for it. 8 MiB is far more than a board an
  agent writes for a card. It keeps every cost below bounded (see Bounds).
- Without `edit: true` the frame shows the board as now: Edit is not
  offered, and no `edit` message is sent.
- A frame granted editing still sends `answers` and `decide` on the same
  channel, as above.
- While editing is granted, the host doesn't post a second `board` to show
  a change. It sends the change on the channel (`remote`, `replace`).
  "Each board has a frame of its own" still holds for a new board: another
  document, or the agent's next published board when not editing.

### Frame to host

- `{ sagebrush: "edit", version: 1, id, base, changes }`
  - `id`: `crypto.randomUUID()`, new for each edit message.
  - `base`: the latest `revision` the frame received. It tells the host
    which state the frame showed; the merge doesn't depend on the host
    still having that state, because each change carries its `was`.
  - `changes`: what the user did since the frame's last `edit`. It is made
    of whole *transactions*: one action of the editor (a drag when it ends,
    a paste, a deletion of the selection, an undo) with every record it
    touches, each change with its `was` as the user saw it when they made
    it. The frame batches the transactions done within 250 ms into one
    message, as long as the message stays within the bounds (see Bounds).
    It never splits a transaction.
- `{ sagebrush: "resync", version: 1 }`: the frame lost track of the
  revisions and asks for the whole board (`replace`).

### Host to frame

Every message that carries a `revision` also carries the `base` it follows
from, except `replace`, which stands alone. `base` is the last revision the
host sent on this channel, which need not be an edit's own `base`.

- `{ sagebrush: "saved", version: 1, id, base, revision, changes, dropped }`:
  the edit `id` was merged.
  - `revision` is the document's state now.
  - `changes` takes the frame's host state from `base` to it, the edit
    itself as merged included. Merged text, or a field a later change won,
    comes back here.
  - `dropped` lists the keys of the edit's changes that had no effect,
    because the record was deleted elsewhere, or a delete was kept back
    because its text was changed elsewhere (see Merging), so that the frame
    can say so. It is often `[]`.
- `{ sagebrush: "remote", version: 1, base, revision, changes }`: a change
  made elsewhere (another tab, another person, an agent writing the file)
  since `base`.
- `{ sagebrush: "replace", version: 1, revision, text, answered }`: the whole
  board, as text, at `revision`. The host sends it when the frame asks
  (`resync`), after a refusal without `retryAfter`, or when a `saved` or
  `remote` would pass the bounds. `answered` lists the edits this message
  answers, as `[{ id, outcome: "saved" | "refused", dropped?, message? }]`:
  - an edit merged whose `saved` would have passed the bounds;
  - any other edit not answered by its own `saved` or `refused`.
- `{ sagebrush: "refused", version: 1, id, message, retryAfter? }`: the edit
  `id` was not merged. `message` is the host's own words, at most 500
  characters, as for submissions.
- `{ sagebrush: "editing", version: 1, allowed: false, message }`: editing
  ends (the file became read-only, the user lost access). The frame leaves
  Edit, drops its unsaved changes, says `message` and shows the board as it
  is. Answers still work if the channel does.

**Every edit is answered exactly once:** by its `saved`, by its `refused`,
or by an entry in a `replace`'s `answered`, never more than one of these.

### Revisions, answers and the frame's view

- **Revisions are the host's.** They form a chain: every `saved` and
  `remote` names the revision it follows (`base`). The frame keeps the
  latest revision it received, and compares revisions only for equality:
  it never orders them or makes its own.
- **The frame keeps two things:** the host's state at the latest revision,
  and its own transactions not yet saved (the edit in flight, then those
  made since), each change with its `was`. It shows the host's state with
  its own changes over it.
- **Answers come first.** The frame applies the answer in a `saved`,
  `refused` or `replace` whenever it arrives, even while it waits for a
  `replace`:
  - **saved:** that edit's changes leave its own;
  - **refused:** see Refusals;
  - **`dropped`:** the frame says which of its changes had no effect.
- **Changes come in order.**
  - **A `saved` or `remote` whose `base` is the frame's latest revision:**
    its `changes` are applied to the host's state, with the frame's own
    unsaved changes still over it.
  - **A `base` that isn't the latest revision:** the frame applies the
    message's answer (above), not its `changes`. It sends `resync`, and
    ignores further `changes` until a `replace` arrives.
  - **`replace`:** the host's state becomes that text at that revision. The
    frame's unsaved changes stay over it, with these exceptions:
    - a change to a record that isn't there now: kept if it is a creation
      (`create`) or touches a text column (its `record` restores it), and
      otherwise dropped, said;
    - every other change: kept, `was` and all, for the next edit.
- **One edit in flight.** The frame sends an `edit` only when no other
  awaits its answer. What the user does meanwhile goes into the next one,
  each change still carrying the `was` the user saw. A port delivers in
  order, and the host answers edits in the order they came.

### Merging

The host merges each change into its document as it is now, field by
field, as CoCalc's syncdb (`dbMerge3`) merges concurrent changes. So the
card and the full editor decide the same way.

- **set, on a record that exists:** each field in `fields`:
  - **a text column:** the change from `was` to the new value, applied as
    a text patch to the field as it is now. Both people's typing is kept.
    The patch is one span: what changed between `was` and the new value,
    found by the common start and end. It is placed in the field as it is
    now the same way, so it takes one linear pass over each text and never
    searches.
    - Changes in separate spans are both kept. Two insertions at one place
      are both kept, the one made elsewhere first.
    - Where the two spans overlap, this edit's text wins over the whole
      span it changed, and typing elsewhere inside that span is lost. An
      edit that changes the first and the last letter (`abcde` to
      `AbcdE`) spans the whole field. This is resolution by span: it keeps
      separate typing, but it isn't dbMerge3's character-level merge;
  - **a map** (a plain object: `was`, the new value and the current one all
    objects, such as the pictures' sizes): merged key by key, recursively,
    by these same rules, as dbMerge3 merges maps. A key changed only
    elsewhere keeps that change, and a key added on both sides keeps both;
  - **any other value** (a number, a list, a switch from one kind to
    another): takes the new value. This edit is the later side.
- **set with `create`:** the record is made from `fields`. If one with that
  key was made meanwhile elsewhere, it is merged as above, against an empty
  `was`.
- **set on a record deleted meanwhile elsewhere:**
  - if the change touches a text column, the record is made again from
    `record`: an edited record is kept whole, never partly;
  - otherwise the change has no effect, and its key is in `dropped`.
- **delete:**
  - if a text column was changed elsewhere since `was`, the record is kept
    (its key in `dropped`);
  - otherwise it is removed. A record already gone is nothing to do.
- **Its cost** is linear in the edit plus the current size of the records
  it touches, plus, when it moves a group, the items under that group
  (found through the index of children, at most the board's 100,000
  records). That can be large: a field rewritten elsewhere to megabytes
  costs a one-letter edit to it a pass over those megabytes. It never
  depends on the rest of the board. Work is limited by bytes for that
  reason (see Bounds). The host needs only its current document: it keeps
  no older revisions. An edit merges the same way whatever `base` it names,
  as must a retry.

### The checks

The host checks every edit, and merges nothing of one that fails any check.
It refuses it without `retryAfter`.

**The message:**
- plain JSON data, checked as for submissions (types first, without
  recursion), nested at most 16 deep;
- `id` a UUID. An `edit` whose `id` the host has already answered (one of
  the last 100, see Bounds) is ignored: nothing is merged and nothing is
  answered. The frame never sends an `id` twice, so only a misbehaving
  frame meets this;
- each change well formed:
  - `op` one of the two, and `type` one of the four;
  - `page` and `id` strings of at most 200 characters;
  - at most 200 fields, with names of at most 64 characters, and never
    `__proto__`, `constructor` or `prototype`. Records are plain objects
    whose fields are set as own properties only;
  - `was` has exactly the fields of `fields` (none with `create`);
  - `record`, when given, the change's record whole, with the same key.

**The board that results:** after the merge, these hold for every record
the edit touched and those beside it (its parent, its children, its
edges, its page):
- **the doc record** is there, and keeps its key;
- **pages:**
  - a paged board has at least one page record;
  - every item and edge is on a page that has its record (`""` when not
    paged);
- **parents:** an item's `parent` is `""` or the id of a group item on the
  same page. Following parents never comes back to the item, and goes at
  most 64 levels. When an edit moves a group, or makes one, every item
  under it is checked too: a move can push a distant descendant past 64
  levels;
- **no orphans:** a group with children isn't deleted, and an item that an
  edge names isn't deleted, unless the same edit moves or deletes those
  too;
- **edges:** `from` and `to` name items on the edge's page;
- **ids:** within a page, two items never share an id, nor two pages, as
  the keys guarantee. Items on different pages may share one;
- **size:** at most 8 MiB as UTF-8 JSON. This is a running total of each
  record's exact encoded size, updated by the records touched;
- **count:** at most 100,000 records, so that the indexes stay small
  whatever the board's shape.

The checks start from the records touched and use indexes the host keeps:
- each page's items and their kinds;
- each group's children;
- each item's number of edges.

Remote changes update the indexes and the running size as edits do.

Nothing re-reads or re-serializes the whole board for an edit. A board
that broke a rule before the edit (an agent wrote it so) doesn't make
every edit fail: the edit is refused only for what its own records and
their neighbours break.

Sagebrush provides the merge, the checks and the indexes as one object,
`editState(postedText)` in `sagebrush-board/submission`, beside
`checkSubmission`. It has `apply(message)` and `remote(changes)`, so that
every host merges and checks the same way. Its tests:
- **compare it with a whole-board check**, on random sequences of edits:
  anything the whole-board rules refuse, it refuses;
- **measure the CPU time and peak heap:**
  - of a small edit and of a remote change against an 8 MiB board, which
    stay proportional to the edit and the records it touches, not to the
    board;
  - of the adversarial merge: `was: "A"`, the field now nearly 8 MiB, an
    edit A to AB. Linear in that field, with no superlinear step;
  - of the indexes for an 8 MiB board of the densest shape (the most
    small pages, items and edges the caps allow).

**What an edit is.** An edit is the user's, made with the frame's editor.
The board's own code runs in a nested frame of another origin and never
has the port. The host still treats an edit as untrusted data. It changes
only the document the host chose for this channel, never one the message
names, and nothing outside it. Nothing runs because of it.

### Refusals

- **With `retryAfter`** (milliseconds; the host is busy, or the rate was
  passed): nothing was merged, and that `id` is answered for good. The
  frame keeps those changes in its own, each with its `was`. No sooner than
  that, it sends them, with what was done since, as a **new edit**: a new
  `id`, `base` the latest revision it received, and the changes checked by
  the host as any edit's. Because each change carries its `was`, the retry
  merges exactly as the first try would have, whatever changed meanwhile.
  The old `id` is never sent again.
- **Without it** (the edit failed a check): nothing was merged. The frame
  drops the refused changes and those made after them, since they were
  made on top of the refused ones, and shows `message`. It keeps a copy of
  what it dropped, which the user can download as JSON. The host follows
  with a `replace`.

### Bounds

- **One message** on the channel (`edit`, `saved`, `remote`) is at most
  **1 MiB** as UTF-8, with at most **1,000 changes**.
  - **A host change set past that** goes as a `replace`, with the answers
    it carries in `answered`.
  - **The frame** batches only whole transactions. Past the bound, it sends
    them in several edits, one after another, each in flight in turn, and
    each made of whole transactions. Each edit is merged or refused as a
    whole. A refusal without `retryAfter` drops that edit and those after
    it; edits already saved stay saved.
  - **A single transaction past the bound** (a paste of more than 1 MiB,
    or a change to more than 1,000 records) is never sent: the frame undoes
    it at once and says it is too large to save here.
- **A `replace`** is at most 8 MiB of text (an editable board's limit). The
  host sends at most one every 2 seconds per channel, and at most 32 MiB
  of `replace` text per minute. A change set that would need another
  `replace` sooner waits, and only the latest state is sent. Changes that
  arrive meanwhile are folded into it, never queued, and so are the
  answers it carries.
- **Rate:**
  - the frame sends at most one edit in flight, batched over 250 ms, so a
    few a second while someone types or drags;
  - the host accepts edits from a bucket of 20 per channel, refilled at 2
    a second: a burst of up to 20 at once, then 2 a second sustained. It
    refuses beyond that with `retryAfter`, the time until the bucket has
    one again;
  - and by **work**: each edit costs its own size plus the current UTF-8
    size of the records it touches. When it moves a group, it also costs
    64 bytes for each item under it. That is charged once the merge has
    counted them, so the budget may go below zero, and the next edits
    wait. Each channel has a budget of 32 MiB,
    refilled at 3.2 MiB a second, so at most 32 MiB of merging at once and
    3.2 MiB a second sustained. An edit past the budget is refused with
    `retryAfter`, and nothing of it is merged. An edit whose cost is more
    than the whole budget can't be needed: an editable board is at most
    8 MiB;
  - the host sends `remote` at most 4 times a second per channel,
    coalescing what arrives meanwhile into one change set.
- **Ids:** the host remembers the last 100 answered edit ids per channel,
  as for submissions. This is a bounded window, not a guarantee for the
  channel's lifetime. The frame never repeats an id. If a misbehaving frame
  repeats one older than the window, it is checked and merged as a new
  edit: the user's own change, made again.

## Privacy

The frame posts `ready` and `error` to `"*"` because it cannot know its
parent's origin. They still go only to `window.parent`, the page that
embeds the frame. Answers go only on the channel the parent gave, so only
the parent receives them. That parent is the page the user is answering
in, so nothing in a submission is hidden from it.

## An example host

```js
const FRAME = "https://sagebrush.space/frame/board/";
let frame = null, port = null; // (the board's frame now, and its channel: only to close them)
// Each board in a frame of its own: a new iframe element, given a nonce only it has
function showBoard(text, name, revision) {
  frame?.el.remove();
  port?.close();
  port = null;
  const el = document.createElement("iframe");
  const me = { el, nonce: crypto.randomUUID(), granted: false, loads: 0, posted: { text, name, revision } };
  frame = me;
  el.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads");
  // (a second load is another document, which this host didn't load: no more answers from this frame)
  el.addEventListener("load", () => { if (++me.loads > 1 && frame === me) { me.granted = true; port?.close(); port = null; } });
  el.src = FRAME + "#sb-nonce=" + me.nonce;
  container.append(el);
}
addEventListener("message", (e) => {
  const me = frame, m = e.data;
  if (!me || e.source !== me.el.contentWindow || m?.sagebrush !== "ready" || m.version !== 1) return;
  // (the document the element was loaded with, once: only it was given the nonce)
  if (me.granted || me.loads > 1 || m.nonce !== me.nonce) return;
  me.granted = true;
  openChannel(me);
});
function openChannel(me) {
  const ch = new MessageChannel(), p = ch.port1;
  port = p;
  // (this channel's own: a handler still running for an earlier channel never sees or changes them)
  const posted = me.posted, taken = new Set(), pending = new Set();
  const say = (sagebrush, id, message) => p.postMessage({ sagebrush, version: 1, id, ...(message ? { message } : {}) });
  p.onmessage = async (e) => {
    const m = e.data;
    // (checkSubmission: Sagebrush's check, against the board posted on this channel)
    const r = checkSubmission(posted, m);
    if (!r.ok) return r.id && say("refused", r.id, r.message);
    if (taken.has(m.id)) return say("received", m.id);
    if (pending.has(m.id)) return; // (the first one's outcome answers)
    if (taken.size + pending.size >= 100) return say("refused", m.id, "too many submissions");
    pending.add(m.id); // (before anything asynchronous)
    // (admitDurably: delivers it as guidance to the agent's running turn,
    // else as a new turn (Delivery); resolves once that is saved, rejects
    // on a definite failure; the submission id is the delivery's
    // idempotency key at the service, which it asks again on an unknown
    // outcome)
    try {
      await admitDurably({ idempotencyKey: m.id, from: currentUser, stale: posted.revision !== currentRevision(), submission: r.submission });
      taken.add(m.id);
      say("received", m.id);
    } catch (err) {
      // (a message of the host's own words, short: never an exception's text as it is)
      say("refused", m.id, "not sent: " + shortReason(err));
    } finally {
      pending.delete(m.id);
    }
  };
  me.el.contentWindow.postMessage({ sagebrush: "board", version: 1, ...posted }, "*", [ch.port2]);
}
```

## Status

- Editing (the section above) is specified, not built. The frame's side and
  `editState` come with CoCalc's step 2, which saves edits made in the card
  to the file.

- Ask items, `sb board answers` and the controls are built in the order of
  /scratch/sagebrush-reviews/boards-both-ways-plan.md.
- The nonce, the channel, `revision`, `answers`, `received`, `refused` and
  `checkSubmission` are new. So are `decide`, `decided` and `decideRequest`.
  test/board-host-protocol.test.ts runs the example host above against
  simulated frames, a navigated one too.
- The frame (web/board/page.ts, channel.ts) takes the nonce and the port,
  and has the Submit bar: **Submit** in its top bar, on a page with
  questions, opens a panel with the comment field (its math typeset under
  it) and **Send**. A question with a `decide` has **Get feedback on my
  words**. web/board/test-submit.mjs plays a host against the real frame:
  each message passes `checkSubmission` or `decideRequest`, and every
  answer from the host is shown as this file says.
