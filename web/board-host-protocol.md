# A board's host: showing a board and taking its answers

A *host* is a page that shows a board to its user and passes what the user
answers back to whoever made the board. The first host will be CoCalc's
chat artifact card, which shows a `.board.json` file an agent published and
turns the user's answers into the next chat turn. This file is the contract
between such a host and the board. design/frame.md covers the frame itself:
what it is, its sandbox, and showing a board without answers.

## The loop

1. An agent writes a board. One of its pages asks the user things: items of
   `kind: "ask"` (web/board-format.md).
2. The host embeds `https://sagebrush.space/frame/board/` and posts it the
   board, with a `revision` of its own (for example the artifact's version).
3. The user answers with the board's controls and presses **Submit**. The
   frame posts the page's answers, with the `revision` it was given, to the
   host.
4. The host gives them to the agent as the user's message.
5. The agent records the answers in the file
   (`sb board answers FILE --apply SUBMISSION.json`), updates the board,
   and publishes it again. The host posts the new board, and the user sees
   it.

## The messages

All messages are objects with a `sagebrush` field naming the message and
`version: 1`. A receiver ignores fields it doesn't know, and messages with
another `version`. Every message the frame sends goes to `window.parent`
only (target `"*"`: see Privacy).

From the frame:

- `{ sagebrush: "ready", version: 1 }`: the frame listens. It says this
  again after every later board, because each board starts the frame afresh.
- `{ sagebrush: "error", version: 1, message }`: a posted text that isn't a
  board. The board shown stays.
- `{ sagebrush: "answers", version: 1, id, name, revision, page, answers, comment }`:
  a submission. The frame sends one for each press of Submit, and only on
  that press: never on load, a timer, or the board's code.
  - `id`: a random string, new for each submission. The host uses it to
    take each submission once.
  - `name`, `revision`: as the host posted them in `board`, or `null`.
  - `page`: `{ number, id?, title? }`. `number` counts from 1, as `#p2` does
    in the board format.
  - `answers`: an object mapping the id of each ask item on that page that
    has an answer to its answer. The answer has the item's input's shape
    (web/board-format.md): a string, a string array, a number or a boolean.
    Unanswered items are left out. Submit cannot be pressed while a
    `required` item is unanswered.
  - `comment`: the text of the Submit bar's comment field, possibly `""`.

From the host:

- `{ sagebrush: "board", version: 1, text, name?, revision? }`: the board to
  show. `revision` is any string up to 200 characters; the frame only echoes
  it back.
- `{ sagebrush: "received", version: 1, id }`: optional. It tells the frame
  the submission `id` was taken. The frame then shows "Received" in place of
  "Sent".

## Limits

The frame never sends more than these. The host checks them again and
refuses a submission over them:

| what | at most |
|---|---|
| a text answer, the comment | 10,000 characters |
| a check answer's values | the item's options, at most 100 |
| ask items on a page | 200 |
| the whole message, as JSON | 64 KB |

## The host's duties

- **Source.** Take messages only from the frame you embedded:
  `e.source === iframe.contentWindow`. The board's code runs in a nested
  frame of its own, so its messages have another source. A board's code
  cannot send a submission, and cannot press Submit.
- **Whose message.** A submission is the user's own message, typed in a
  form. The agent gets it as text from that user, quoted as data. It is not
  an instruction from the host, and not an approval of anything outside the
  board. Nothing runs because of it.
- **Staleness.** When `revision` is not the board's current one, the host
  says so with the message, for example: "answers to an earlier version of
  the board". It still delivers the message, and lets the agent decide.
- **Once.** Deliver each `id` once. Disable or acknowledge the submission
  (`received`), so that a second press doesn't start a second turn.
- **Unsent answers.** The frame keeps nothing: it has no storage. Posting a
  new board restarts the frame, and answers not yet submitted are lost. So
  post a new board only when the agent has published one, and preferably
  not while the user is typing.

## Privacy

The frame posts to `"*"` because it cannot know its parent's origin. The
message still goes only to `window.parent`, the page that embeds the frame,
which is the page the user is answering in. Nothing in it is hidden from
that page.

## An example host

```js
const f = document.querySelector("iframe"); // src: https://sagebrush.space/frame/board/
let shown = { text, name: "decisions.board.json", revision: "r7" };
const taken = new Set();
addEventListener("message", (e) => {
  if (e.source !== f.contentWindow) return;
  const m = e.data;
  if (m?.version !== 1) return;
  if (m.sagebrush === "ready") f.contentWindow.postMessage({ sagebrush: "board", version: 1, ...shown }, "*");
  if (m.sagebrush === "answers" && typeof m.id === "string" && !taken.has(m.id) && JSON.stringify(m).length <= 65536) {
    taken.add(m.id);
    sendToAgent({ from: currentUser, stale: m.revision !== shown.revision, submission: m });
    f.contentWindow.postMessage({ sagebrush: "received", version: 1, id: m.id }, "*");
  }
});
```

## Status

- Ask items, `sb board answers` and the controls are built in the order of
  /scratch/sagebrush-reviews/boards-both-ways-plan.md.
- `revision`, `answers` and `received` are new. Until the frame supports
  them, it ignores `revision` and `received`, and never sends `answers`.
