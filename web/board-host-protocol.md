# A board's host: showing a board and taking its answers

A *host* is a page that shows a board to its user and passes what the user
answers back to whoever made the board. The first host will be CoCalc's
chat artifact card. It shows a `.board.json` file an agent published, and
turns the user's answers into the next chat turn. This file is the contract
between such a host and the board. design/frame.md covers the frame itself:
what it is, its sandbox, and showing a board without answers.

## The loop

1. An agent writes a board. One of its pages asks the user things: items of
   `kind: "ask"` (web/board-format.md).
2. The host embeds `https://sagebrush.space/frame/board/`. It posts the
   board to the frame with a `revision` of its own (for example the
   artifact's version) and one end of a new `MessageChannel`.
3. The user answers with the board's controls and presses **Submit**. The
   frame sends the page's answers over that channel.
4. The host checks the submission against the board it posted on that
   channel. It then gives the submission to the agent as data the user
   submitted.
5. The agent records the answers in the file
   (`sb board answers FILE --apply SUBMISSION.json`), updates the board,
   and publishes it again. The host posts the new board on a new channel,
   and the user sees it.

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
- Each later `board` message starts the frame afresh, as design/frame.md
  says. The old document and its port are gone, and the host closes the
  old `port1`.

The channel is what binds a submission to the frame document the host gave
the board to. `e.source === iframe.contentWindow` only names a browsing
context. A `WindowProxy` stays the same when the frame is navigated to
another document, and that document could post from it, but it never had
the port. The host still checks the source of every window message it acts
on (`ready`), but takes answers only from the port.

A host that posts a board without a port gets the board shown without
Submit. Showing a board needs no channel.

## The messages

All messages are objects with a `sagebrush` field naming the message and
`version: 1`. A receiver drops messages with another `version`, and fields
it doesn't know.

On the window (`postMessage` to `window.parent`, or to the frame's
`contentWindow`):

- From the frame: `{ sagebrush: "ready", version: 1 }`. The frame listens,
  and says it again after every later board.
- From the frame: `{ sagebrush: "error", version: 1, message }`. A posted
  text isn't a board; the board shown stays.
- From the host: `{ sagebrush: "board", version: 1, text, name?, revision? }`,
  with the transferred port. `revision` is any string up to 200 characters,
  which the frame only echoes back.

On the channel:

- From the frame: `{ sagebrush: "answers", version: 1, id, name, revision, page, answers, comment }`.
  - `id`: `crypto.randomUUID()`, made when the user presses Submit with
    answers not sent before. A press that sends again (see Once) reuses it.
  - `name`, `revision`: as posted in `board`, or `null`.
  - `page`: `{ number, id?, title? }`. `number` counts pages from 1, as `#p2`
    does in the board format.
  - `answers`: an object. It maps the id of each ask item on that page that
    has an answer to its answer, in the shape of the item's input
    (web/board-format.md). Unanswered items are left out. Submit can't be
    pressed while a `required` item is unanswered.
  - `comment`: the text of the Submit bar's comment field, possibly `""`.
- From the host: `{ sagebrush: "received", version: 1, id }`. The submission
  `id` was admitted durably as the agent's turn (see Once); the frame shows
  "Received".
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
| `answers` | at most 200 keys, each the id of an ask item on that page |
| each answer | the item's shape: `check` a list of at most 100 distinct values of its options (`true` or `false` without options); `radio` and `choice` one value of its options; `text` a string; `number` a number within its `min`/`max` and on its `step`; `scale` a whole number from its `min` to its `max` |
| a text answer, `comment` | strings of at most 10,000 characters |
| required items | each has an answer |

- Fields other than these are dropped, not passed on.

Sagebrush provides the check as a function of the board's text and the
message, so that every host checks the same way. It goes in the
`sagebrush-board` package, built with the Submit bar.

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
  - `received` means the agent's turn was admitted durably (in CoCalc, the
    chat message saved), not that the message arrived. The host awaits
    that admission, then marks the `id` taken and sends `received`. It
    answers a repeat of a taken `id` with `received` again.
  - When admission definitely fails, the host forgets the pending `id` and
    sends `refused` with the reason. The user can send again with the same
    `id`.
  - When the outcome is unknown (a timeout, a lost connection), the host
    asks the service with the `id` before it answers. The submission `id`
    is the idempotency key of the turn it starts, at the service and not
    only in the page, so that a submission sent again after a reload or
    from another tab can't start a second turn.
  - The host keeps at most 100 ids per channel and refuses submissions
    past that. The ids go when the channel is closed; the service's keys
    last as long as its own idempotency window.
- **Unsent answers.** The frame keeps nothing: it has no storage. Posting a
  new board restarts the frame, and answers not yet submitted are lost. So
  post a new board only when the agent has published one, and preferably
  not while the user is typing.

## Privacy

The frame posts `ready` and `error` to `"*"` because it cannot know its
parent's origin. They still go only to `window.parent`, the page that
embeds the frame. Answers go only on the channel the parent gave, so only
the parent receives them. That parent is the page the user is answering
in, so nothing in a submission is hidden from it.

## An example host

```js
const f = document.querySelector("iframe"); // src: https://sagebrush.space/frame/board/
let port = null, posted = null, taken = null, pending = null;
function show(text, name, revision) {
  port?.close();
  const ch = new MessageChannel();
  port = ch.port1;
  posted = { text, name, revision };
  taken = new Set();
  pending = new Set();
  const p = port, say = (sagebrush, id, message) => p.postMessage({ sagebrush, version: 1, id, ...(message ? { message } : {}) });
  p.onmessage = async (e) => {
    const m = e.data;
    // (checkSubmission: Sagebrush's check, against the board posted on this channel)
    const r = checkSubmission(posted, m);
    if (!r.ok) return r.id && say("refused", r.id, r.message);
    if (taken.has(m.id)) return say("received", m.id);
    if (pending.has(m.id)) return; // (the first one's outcome answers)
    if (taken.size + pending.size >= 100) return say("refused", m.id, "too many submissions");
    pending.add(m.id); // (before anything asynchronous)
    // (admitDurably: resolves once the turn is saved, rejects on a definite
    // failure; the submission id is the turn's idempotency key at the
    // service, which it asks again on an unknown outcome)
    try {
      await admitDurably({ idempotencyKey: m.id, from: currentUser, stale: posted.revision !== currentRevision(), submission: r.submission });
      taken.add(m.id);
      say("received", m.id);
    } catch (err) {
      say("refused", m.id, "not sent: " + err.message);
    } finally {
      pending.delete(m.id);
    }
  };
  f.contentWindow.postMessage({ sagebrush: "board", version: 1, text, name, revision }, "*", [ch.port2]);
}
addEventListener("message", (e) => {
  if (e.source === f.contentWindow && e.data?.sagebrush === "ready" && e.data.version === 1) show(currentText(), "decisions.board.json", currentRevision());
});
```

## Status

- Ask items, `sb board answers` and the controls are built in the order of
  /scratch/sagebrush-reviews/boards-both-ways-plan.md.
- The channel, `revision`, `answers`, `received`, `refused` and
  `checkSubmission` are new. Until the frame supports them, it ignores the
  port and `revision`, and shows no Submit.
