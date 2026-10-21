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
- `{ sagebrush: "editing", version: 1, allowed: false, message, reason?, keepUnsaved? }`:
  editing ends (the file became read-only, the user lost access, the
  history is full). The frame leaves Edit, says `message` and shows the
  board as it is. Answers still work if the channel does.
  - **Without `keepUnsaved`**, as before: the frame drops its unsaved
    changes.
  - **With `keepUnsaved: true`**, for any reason: the frame keeps them for
    the user to download, as it keeps a refused edit's. That covers its
    view of the board with them applied (the host's last revision with the
    frame's unsaved changes over it) and its transactions not yet saved,
    each change with its `was`. It says so beside `message`, offers
    Download, and never sends them again on this channel. What it keeps is
    then **frozen**: nothing is added to it (Edit has ended), and it is
    within the frame's unsaved-state bound (see Bounds), so it can't grow.
    It is released only when the user discards it, or the page closes.
    Downloading it doesn't release it, since a page can't tell whether a
    download finished; the user can download it again. A host sends it
    when the user's work can't be taken now but shouldn't be lost: the
    history is full, the user's quota is spent, the document moved or
    became read-only while they typed.
  - `reason` is one of the Refusal reasons' codes (`"history-full"`,
    `"quota"`, ...), for the frame to act on beside `message`.
    `"history-full"` always comes with `keepUnsaved: true`.
  - An older frame, from before its editing side was built, acts as
    without the flag, since a receiver drops fields it doesn't know.

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
  - **a map** (the new value and the current one both plain objects, such
    as the pictures' sizes): merged key by key, recursively, by these same
    rules, as dbMerge3 merges maps. If `was` isn't a map (the field wasn't
    there), the merge is against `{}`, and the same holds at every level.
    So a key changed only elsewhere keeps that change, and keys added on
    both sides keep both, even for the first picture of a board;
  - **any other value** (a number, a list, a switch from one kind to
    another): takes the new value. This edit is the later side;
  - **a field removed on one side and changed on the other** (a field set
    to `null` here, changed elsewhere since `was`, or the reverse): the
    change is kept, at every level of a map, as dbMerge3 keeps it.
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
  it touches. When the edit moves or makes groups, it also costs one visit
  to each item under them, shared, at most the board's 100,000 records, and
  temporary memory for those visits. That can be large: a field rewritten elsewhere to megabytes
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
  levels. This is **one walk per edit**:
  - it starts from the groups the edit moved or made;
  - a visited set is shared by all of them, so each item is visited at
    most once per edit, however the groups' subtrees overlap;
  - it keeps its visited set by each item's whole key (page and id), so it
    ends on data that already goes round (an agent's: A's parent is B and
    B's is A), since nothing is visited twice. A cycle met under a moved or
    made group refuses the edit.

  Following an item's parents likewise stops at a parent seen before (a
  cycle: refused) or after 64 levels (refused);
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
    small pages, items and edges the caps allow);
  - of an edit whose walk visits 100,000 items: once each, however many
    groups it moves.

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
  what it dropped, which the user can download as JSON, until the user
  discards it or the page closes. That copy counts in the frame's
  unsaved-state bound (see Bounds). The host follows with a `replace`.

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
- **The frame's unsaved state** (daybreak2's LIMIT-9B5-1) is bounded in
  total, not only per message. The bound covers the edit in flight, the
  transactions made since and not yet sent, and every copy kept for the user
  to download (a refused edit's, and what `keepUnsaved` keeps), each change
  with its `was`. A host that never answers, or answers only with
  `retryAfter`, can't make it grow past the bound.
  - **Counted as it changes:** the frame keeps two running totals, the
    UTF-8 size of these changes as they would be sent and their number. A
    transaction adds to them when it is made, and an answer that settles
    changes takes them off. Each step costs only the change counted,
    never what is already held: nothing is re-serialized to count.
  - **The bound:** at most **8 MiB** and **8,000 changes** in all, eight
    messages' worth.
  - **Editing pauses before it**, never past it, and nothing is dropped.
    - When the totals are within one transaction's maximum of the bound
      (1 MiB or 1,000 changes, as above), Edit is paused before the next
      transaction can start. So every transaction already made fits, and
      none is undone or lost.
    - The frame says "Waiting for the host to save your changes", and keeps
      showing its view with them.
    - It offers **Download** (everything held, as below). It never sends
      more than the rules above allow: still one edit in flight, and a
      refused one again only after its `retryAfter`.
    - Edit comes back on its own when answers take the totals below half
      the bound.
    - A copy kept for download counts until it is discarded. So with copies
      held, the user may have to download and discard one to go on editing,
      and the frame says so.
  - **The download is bounded too.** It is made only when the user asks,
    as a `Blob` from parts: the view's text, then one part per transaction.
    No second whole-state string is ever built. It is at most the bound plus
    an editable board (8 MiB), and its object URL is revoked once the
    download has been handed to the browser.
  - The frame's memory for all of this is therefore bounded by the bound
    times a constant (the parsed changes beside their counted size), plus
    one editable board for its view.
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
    size of the records it touches, charged before the merge. Its walk
    under moved or made groups costs 64 bytes a visit, charged as it goes:
    a walk that would pass what is left of the budget stops there, and the
    edit is refused with `retryAfter`, with nothing merged. The budget
    never goes below zero, and a walk is at most 100,000 visits (6.4 MB of
    budget). Each channel has a budget of 32 MiB,
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

## Refusal reasons

Every `refused` the host sends (for a submission, a decide, an edit, or a
picture) may also say **why, as a code**, so that the frame can act on it as
well as show `message`:

`{ sagebrush: "refused", version: 1, id, message, reason?, what?, limit?, size?, retryAfter? }`

| `reason` | meaning | `retryAfter` | the frame |
|---|---|---|---|
| `"busy"` | the rate or a work budget: nothing was done | always | sends again no sooner, as Refusals says for edits |
| `"too-large"` | past a bound; `what` names it, `limit` and `size` give the bound and the amount | never | as a refusal without `retryAfter`; says how large |
| `"history-full"` | the host can keep no more of the document's history | never | leaves Edit: an `editing` with `allowed: false, keepUnsaved: true` follows, and the frame keeps its unsaved changes for download |
| `"quota"` | the user's or the board's pictures are past the host's quota | never | takes the picture out of its own changes, says `message` |
| `"invalid"` | the message failed a check | never | as a refusal without `retryAfter` |

- `what` (with `"too-large"` only, and always with it) is one of:
  - `"item"`: one record;
  - `"edit"`: the message's bytes;
  - `"values"`: the message's number of values (strings, numbers, keys and
    entries all told; at most 200,000);
  - `"changes"`: the message's number of changes;
  - `"work"`: the merging an edit needs;
  - `"board"`: the board's bytes;
  - `"records"`: the board's number of records;
  - `"image"`: one picture's bytes;
  - `"images"`: the board's pictures, all together.
- `limit` and `size` are bytes, except for `"values"`, `"changes"` and
  `"records"`, which count those. Every `"too-large"` carries all three, so a
  host never parses `message`.
- For `"edit"` and `"values"`, `size` is what was counted when the bound was
  passed: the message is measured only that far, so it is at least that
  large.
- A code is a promise about what happened, never a replacement for
  `message`: the frame still shows `message`, the host's own words.
- A frame that doesn't know a code, or a refusal without one, acts as before:
  by `retryAfter` alone.
- No new message type is needed. These are new optional fields of the same
  message, and a receiver drops fields it doesn't know (The messages). An
  `editing` with `allowed: false` may carry the same `reason`.
- editState's refusals carry `reason`: `"busy"`, `"too-large"` (with `what`,
  `limit` and `size`), or `"invalid"`. Its bounds are `"edit"`, `"values"`,
  `"changes"`, `"work"`, `"board"` and `"records"`. `"item"`, `"image"`,
  `"images"`, `"history-full"` and `"quota"` are the host's own: editState
  never knows them.

## Checking an edit at admission: preview

A host that admits an edit in one place and commits it in another (CoCalc
checks it when the message arrives, and merges it when its document is
written) calls `editState.preview(message, now?)` at admission and
`editState.apply(message, now?)` at commit.

- `preview` runs the very same steps as `apply`: the message's checks, the
  rate, the work budget, the merge, the board's checks, the walk. The rate
  and the work it checks are a copy of `apply`'s budgets as they are now, so
  its answer, `"busy"` included, is `apply`'s at that clock (astra's
  CORR-722-1). It changes nothing of the board's: not the records, nor
  `apply`'s budgets, nor the ids answered, nor `lastWalk`.
- **Previews are metered too** (daybreak2's LIMIT-74B-1), by a meter of their
  own, charged by previews alone: twice `apply`'s budgets (40 at once, then 4
  a second; 64 MiB of work, then 6.4 MiB a second), so one preview per edit,
  and its retries, never meet it.
  - Past it, a preview is refused unchecked: `{ ok: false, reason: "busy",
    previewThrottled: true, retryAfter }`. **`previewThrottled` means "not
    computed"**: it says nothing about what `apply` would do.
  - `sharedPreviewBudget(limits?)` makes one meter, which a host can give
    every editState (`editState(text, { previewBudget })`), so that all of
    its previews draw on it together.
  - Like `apply`, each call is bounded: it never walks the whole board.
- **The host MUST bound preview work host-wide**, across boards and
  connections, **and charge `workBytes` to that bound, refused previews
  included.** One board's meter bounds that board alone; an attacker can
  open many. A host does this with its own admission (in CoCalc, A2a's: run
  `preview` inside BoardAdmission's validation, after its per-client rate
  and its global reservation and before anything is queued, charging
  `workBytes` to that reservation and releasing it on refusal), or with one
  `sharedPreviewBudget` for every board, or both.
- **Before calling it, the host checks what costs nothing**, in this order:
  1. the message's encoded size, at most 1 MiB (Bounds);
  2. its own per-client rate and admission;
  3. only then `preview`.
- It returns what `apply` would return now, with three sizes:
  `{ ok: true, id, changes, dropped, boardBytes, editBytes, workBytes }` or
  `{ ok: false, id?, message, reason?, what?, limit?, size?, retryAfter?, ignore?, previewThrottled?, editBytes?, workBytes }`.
  - **`boardBytes`**: the board's size after the edit, as UTF-8 JSON of its
    records, at most 8 MiB. It is editState's own bound, for showing or for
    metrics. **It is never the edit's size**: a host must not charge it to
    an admission that caps edits (CoCalc's BoardAdmission caps a commit at
    512 KiB).
  - **`editBytes`**: the edit's size, which is what an admission that caps
    edits charges. Exactly: the length in UTF-8 of `JSON.stringify(message)`,
    the whole `edit` envelope as received (`sagebrush`, `version`, `id`,
    `base`, `changes`, and any other field it carries). It is absent only
    for a message that can't be serialized.
  - **`workBytes`**: the work the preview did, in the work budget's units:
    the message's size, the current size of each record its changes pass
    over, and 64 for each visit of the walk. A host charges it to its own
    work budget whether the edit was accepted or refused. It is 0 for a
    message refused before any merging.
- Unless it was throttled, then, `apply` with the same message, state and
  clock decides exactly as `preview` did. Between the two, other edits and remote changes can make
  `apply` decide otherwise. So the host still calls `apply` at commit, and
  answers by what it says.
- A preview spends none of `apply`'s budgets: a host that previews and then
  never applies has used none of the frame's edit rate, only the preview
  meter.
- web/board/test-edit-state.mjs checks this on the 2,400 random edits of its
  property test: before each `apply`, a `preview` at the same clock leaves
  the state alone (the records, the size, `lastWalk`) and decides the same
  (accepted or refused, the message, `retryAfter`, the changes, `dropped`,
  the size). It also checks:
  - that a previewed id is not taken as answered, and that `lastWalk` is
    `apply`'s alone;
  - that of 50 previews at one instant, 40 are computed and the rest
    throttled, leaving `apply`'s burst of 20 untouched;
  - that previews of an edit over a 3 MiB record run out of their own meter
    after about 21, each giving its `workBytes`;
  - that after 20 applies a preview predicts `apply`'s `"busy"` (and its
    `retryAfter`), and after 20 previews alone both take the edit;
  - that a shared meter bounds two boards' previews together.

  packages/sagebrush-board/test-contract.mjs and test-contract-722.mjs are
  astra's probes on 74b4e93f and 7222199c (typed refusals, picture shapes,
  the prediction after `apply`-only, preview-only and work-exhausting
  histories). test.mjs runs them against the source and the built
  /submission.

## Pictures: imagePut and imageGet

A board's pictures are named in its doc record's `images`, each
`{ w, h, src? }`. Without a host that keeps them, a board carries their bytes
as `data:` URLs in `src` (design/board.md, Images). **A host that keeps them
itself** has them sent apart, on the channel, and its board names them only:

- **Their names** are `"i"` and the first 128 bits of the SHA-256 of their
  bytes, in lowercase hex: `i` followed by 32 hex digits. That is how the
  frame names a picture (web/board/images.ts). A picture's entry is then
  `{ w, h }`, with no `src`. The name is the reference: the host's own
  storage, and its addresses, never appear in the board.
- **Granting it.** The frame says it can, in its `ready`:
  `{ sagebrush: "ready", version: 1, nonce?, pictures: ["by-reference"] }`.
  The host then grants editing with `{ ..., edit: true, pictures: "by-reference" }`,
  and posts a board text without `data:` URLs. A frame that doesn't say so
  is posted pictures inline, as before.
- **In a host that grants it, editState is made with
  `editState(text, { pictures: "by-reference", pictureAllowed })`.** Where an
  edit changes the board's `images`, editState checks it before any source
  is looked at (astra's CORR-74B-2). Anything else is refused,
  `reason: "invalid"`, at preview and at apply alike, with nothing kept:
  - `images` is a plain map (or none);
  - each picture the edit adds or changes is named `i` and exactly 32
    lowercase hex digits;
  - each such picture's entry is a plain `{ w, h, src? }`, with `w` and `h`
    positive numbers;
  - `src`, if given, is an absolute `https:` URL with a host, as `new URL`
    parses it (never `data:`, `blob:`, `javascript:`, `http:`, relative, or
    `https://` alone);
  - **a picture the board didn't name before is taken only if
    `pictureAllowed(name)` says so** (Authorization, below). Without
    `pictureAllowed` no new picture is taken.

  A picture the board had before, unchanged, is left alone, so a board
  posted with `data:` URLs still takes other edits. Pictures stay inline by
  default.

**Frame to host:**
- `{ sagebrush: "imagePut", version: 1, id, name, type, bytes }`
  - `id`: a UUID, new for each message;
  - `name`: the picture's name, as above;
  - `type`: one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`;
  - `bytes`: an `ArrayBuffer`, transferred.
- `{ sagebrush: "imageGet", version: 1, id, names }`: at most 32 names, each
  one the board names.

**Host to frame:**
- `{ sagebrush: "imageSaved", version: 1, id, name }`: kept, or kept already:
  a name the host has is answered at once, without storing it again.
- `{ sagebrush: "images", version: 1, id, images, missing, more }`
  - `images`: `[{ name, type, bytes }]`, the buffers transferred, at most
    8 MiB of them per message;
  - `missing`: the names the host doesn't have;
  - `more`: the names left for another `imageGet`, past 8 MiB.
- `{ sagebrush: "refused", version: 1, id, message, reason, ... }`, as above.

**The host's checks of an `imagePut`**, all before it keeps anything, in
this order. Each is cheaper than the next, and none is skipped:
- `id` a UUID;
- `name` of the form above;
- `type` one of the four;
- **the byte length, the first check of the bytes:** a picture of more than 2,000,000 bytes is
  refused (`"too-large"`, `what: "image"`) before it is hashed, parsed or
  looked at in any other way;
- the bytes' first bytes those of that type (PNG's signature, JPEG's SOI,
  `GIF87a`/`GIF89a`, `RIFF....WEBP`);
- its size and pixels, read from its header alone (web/image-size.ts
  `imageSizeOf`): each side at most 8,192 pixels, at most 40,000,000
  pixels;
- the SHA-256 of the bytes giving `name`: computed by the host, never
  trusted.

**The host never decodes a picture at ingestion.** The type and size
checks read only the leading bytes and the header, and nothing is decoded,
scaled or converted on the way in. Decoding happens only where a picture is
shown, in a browser, within the same bounds.

A picture that fails one of these is refused with `"invalid"`.

**Bounds:**

| what | bound | past it |
|---|---|---|
| one picture | 2,000,000 bytes (the frame scales anything larger down on the way in: images.ts) | `"too-large"`, `what: "image"` |
| a board's pictures, all its distinct names together | 32 MiB, and 80,000,000 pixels (image-size.ts LOAD_PIXELS) | `"too-large"`, `what: "images"` |
| the user's pictures in the host | the host's quota | `"quota"` |
| in flight, per channel | 4 `imagePut` unanswered and 8 MiB of their bytes; 2 `imageGet` | the frame waits; a host refuses a fifth with `"busy"` |
| rate, per channel | a bucket of 16 MiB of picture bytes, refilled at 2 MiB a second (apart from the edits' work budget) | `"busy"`, `retryAfter` the time until there is room |

**Authorization** (astra's CORR-74B-3). A picture's name is a hash: an
identifier anyone can compute from bytes they have, or learn from another
board. It is never a permission. So the host keeps, for each channel, **the
pictures this channel may name and read**:
- those the board named when the host posted it, and those that trusted
  changes (`remote`, `replace`: the host's own document) add;
- those put on this channel by an `imagePut` that passed every check above,
  the hash included;
- those the host transfers to it explicitly by its own rules (a copy of a
  board the user may read, say).

It never grows from the frame's own edits: an edit naming a picture adds
nothing to the set.
- **At admission and again at commit**, the host gives editState that set
  as `pictureAllowed`. A picture an edit adds that isn't in it is refused,
  `"invalid"`, even if the host keeps those bytes for another document.
  Global deduplication of bytes is fine *after* this: storing H once for
  many boards never lets one board name it.
- **`imageGet`** serves only pictures in that set, never the board's own
  list of names, which an edit could have changed.
- web/board/test-edit-state.mjs checks the first part: a known hash the
  host keeps for another board, never put on this channel, is refused at
  preview and apply; once put and verified on this channel (in the set), the
  same edit is taken.

**Order.** The frame sends a picture's `imagePut`, and waits for its
`imageSaved` (the picture is in the channel's set from then on), before it
sends the edit that names it. A `quota` or `too-large` refusal of a picture
makes the frame take that picture's transaction out of its own changes, and
say why.

**Privacy.** An `imageGet` gets only pictures in the channel's set
(Authorization). A host never serves a picture by name alone from another
document.

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

- Editing (the section above): the frame's side is built
  (web/board/edit-channel.ts, wired in page.ts and mount.ts), with
  `keepUnsaved` and the frame's unsaved-state bound. web/board/test-edit-channel.mjs
  plays `editState` as the host against it, and web/board/test-frame-edit.mjs
  does the same in a real frame, its heap measured. A frame not granted
  editing offers no Edit.
  CoCalc's host side (step 2, which saves edits made in the card to the
  file) is built apart, with `editState`.
- Pictures in an edit, to a host that keeps them inline (no
  `pictures: "by-reference"` yet): the frame sends them as `data:` URLs, as
  posted. An action is taken when it is made (its changes and their `was`,
  counted in the bound); a picture's bytes are read into it after, and it is
  sent once they are, in its turn. One that can't be read is kept for
  download with the actions after it. Its editor names pictures by their content, so the first edit of a
  board whose pictures have other names adds them under those, and an edit
  never removes a picture from the board's map: the bytes of every picture
  the board names stay with the host. Sent by reference (above), a picture
  is named by its content on both sides, so nothing is renamed.
- `editing`'s `keepUnsaved` is implemented in the frame: what it keeps is
  frozen, shown in a bar with Download and Discard, and counted in the bound.
  A `reason` is shown with `message`; the frame doesn't act on it otherwise
  yet.
- The frame's unsaved-state bound (Bounds) is built with it. Its acceptance
  tests (daybreak2's LIMIT-9B5-1) are in test-edit-channel.mjs and, with the
  heap measured, test-frame-edit.mjs:
  - **A host that never answers.** The user changes the same near-limit
    field over and over, each change a large `was` and value. Then:
    - Edit pauses before the bound;
    - no transaction already made is lost;
    - the totals equal the encoded size and count of what is held;
    - the page's heap stays within a measured constant times the bound,
      plus the board.
  - **Then `editing { allowed: false, keepUnsaved: true }`.** What is held
    is frozen: a further attempt to edit adds nothing. The download parses
    back to the view and to every unsaved transaction, each with its `was`.
    Making it doesn't build a second whole copy (heap measured around it).
  - **Only `retryAfter`, again and again.** The same pause, then Edit back
    once answers come and the totals fall below half the bound.
  - **Copies kept from refusals** count toward the bound. Discarding one
    lets editing go on.
- Built in `editState` (`@sagemathinc/sagebrush-board/submission` 0.4.0,
  published with `sagebrush` 0.5.2):
  - `preview`, its meter, `previewThrottled` and `sharedPreviewBudget`;
  - the refusals' `reason`, `what`, `limit` and `size`;
  - `editState(text, { pictures: "by-reference", pictureAllowed })`, with
    its checks of shapes, names and sources, and the authorization of new
    pictures.

  With an older package a host refuses `data:` URLs in edits itself. Specified,
  not built yet: the frame's side of `imagePut`, `imageGet` and
  `pictures: ["by-reference"]` in `ready`, and the frame acting on `reason`.

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
