# A board in another site's page: /frame/board/

Another site shows a live board, its code running, by embedding
`https://sagebrush.space/frame/board/` in an iframe and posting it the board.
The first such site is CoCalc, which will show a `.board.json` file published
as a chat artifact this way.

## What it is

The page is a board downloaded as HTML (web/board/export.ts), served by the
site, with every part inline except the document: the board's script, KaTeX
and its fonts, and the board page as its template, so that Download as HTML
works from it too.  web/build.ts makes it (`frameHtml`).  Its code runs as a
downloaded file's does (web/board/engine.ts): Python in the runner's files
mode, a sandboxed srcdoc frame with no network, and always the engine the
page was built with, fetched from `<this site>/engine/<id>/`, each part
checked against the SHA-256 built into the script.  A posted board that asks
for the latest engine (`engine: "latest"`) gets the built-with one all the
same.  No cross-origin isolation is
needed, so the embedding page needn't have any.

As in a downloaded file, there is no TimeTravel, outputs are kept only while
the page is open (MemoryOutputCache), and edits are not saved anywhere.

## The messages

All are objects with `version: 1`.

- The frame, when it listens: `{ sagebrush: "ready", version: 1 }`.
- The parent: `{ sagebrush: "board", version: 1, text, name? }`, where `text`
  is a file's contents (JSON, a Mermaid flowchart, Markdown with flowcharts,
  a CoCalc whiteboard or a JSON Canvas, as Open… takes) and `name` its file
  name.
- The frame, for a text that isn't a board:
  `{ sagebrush: "error", version: 1, message }`.  The board shown stays.

A host that also takes the user's answers back (ask items, Submit) follows
web/board-host-protocol.md, which adds a channel for them (a transferred
`MessageChannel` port), `revision`, `answers`, `received` and `refused`.

A later board starts the frame afresh: it reloads, a new page with a new
interpreter, so that nothing the first board's code did (a module changed,
a file written, a run still going) reaches the next; and it says `ready`
again.  So a parent answers every `ready` with the board it wants shown.
Only messages from `window.parent` count.  What the frame posts is no secret,
so it posts to any parent (`"*"`).  Opened on its own, the page shows an
empty board that says what it is for.

## Security

The page's Content-Security-Policy (web/csp-policy.mts, `framePolicy`) has
`sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox
allow-downloads`, without `allow-same-origin`.  The page therefore has an
opaque origin however it is embedded, with the iframe's `sandbox` attribute
or without it, and even when opened on its own.  A board some page posts to
it can never run as sagebrush.space, nor read or write the site's storage.
This holds on every browser that supports the CSP `sandbox` directive
(Chrome, Firefox, Safari).

That sandbox, not the script policy, is what keeps others' code away from the
site.  The script policy allows what a downloaded file runs:
- the page's inline scripts, by their hashes;
- the engine's and KaTeX's modules, from `blob:` URLs;
- `eval`, because the interpreter compiles Python to JavaScript;
- the runner's srcdoc frame's one inline script, by its hash.  The srcdoc
  inherits the page's policy, so the hash is in it; the script lives in
  web/notebook/files-runner.js so that web/csp.ts can hash it.

`frame-ancestors *`: any page may embed it.  It holds nothing an embedder
could take by framing it.  `Cross-Origin-Resource-Policy: cross-origin`, so
that a cross-origin isolated page can embed it too.  The Cache-Control
`no-transform` keeps the host from adding its analytics script.  All three
are in the one `/frame/*` rule web/csp.ts writes: Cloudflare keeps only the
last rule given for a path, so csp.ts refuses a path given twice.  The local
server (web/serve.py) does the same, and matches rules against the decoded,
normalized path, so no spelling of the frame's path is served without them.

web/board/test-frame.mjs checks:
- the policy;
- the opaque origin, without a sandbox attribute;
- no storage;
- the board shown and its code run;
- only the parent's messages counting;
- replacement, in a new interpreter (the first board's mark on `builtins`
  gone);
- one `/frame/*` rule with all its headers, and other spellings of the path;
- the error;
- the page opened on its own.

## For an embedder

```html
<iframe src="https://sagebrush.space/frame/board/" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads"></iframe>
<script>
const f = document.querySelector("iframe");
addEventListener("message", (e) => {
  if (e.source !== f.contentWindow) return;
  // (on every ready: the frame starts afresh for each later board)
  if (e.data?.sagebrush === "ready") f.contentWindow.postMessage({ sagebrush: "board", version: 1, text, name: "foo.board.json" }, "*");
});
</script>
```

(The `sandbox` attribute is a second lock: the page sandboxes itself.)
