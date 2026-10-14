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
mode, a sandboxed srcdoc frame with no network, and the engine the page was
built with, fetched from `<this site>/engine/<id>/`, each part checked
against the SHA-256 built into the script.  No cross-origin isolation is
needed, so the embedding page needn't have any.

As in a downloaded file, there is no TimeTravel, outputs are kept only while
the page is open (MemoryOutputCache), and edits are not saved anywhere.

## The messages

All are objects with `version: 1`.

- The frame, when it listens: `{ sagebrush: "ready", version: 1 }`.
- The parent: `{ sagebrush: "board", version: 1, text, name? }`, where `text`
  is a file's contents (JSON, a Mermaid flowchart, Markdown with flowcharts,
  a CoCalc whiteboard or a JSON Canvas, as Open… takes) and `name` its file
  name.  The first shows; a later one replaces it.
- The frame, for a text that isn't a board:
  `{ sagebrush: "error", version: 1, message }`.  The board shown stays.

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
could take by framing it.  `Cross-Origin-Resource-Policy: cross-origin`
(web/_headers), so that a cross-origin isolated page can embed it too.  The
Cache-Control `no-transform` keeps the host from adding its analytics script.

web/board/test-frame.mjs checks:
- the policy;
- the opaque origin, without a sandbox attribute;
- no storage;
- the board shown and its code run;
- only the parent's messages counting;
- replacement;
- the error;
- the page opened on its own.

## For an embedder

```html
<iframe src="https://sagebrush.space/frame/board/" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads"></iframe>
<script>
const f = document.querySelector("iframe");
addEventListener("message", (e) => {
  if (e.source !== f.contentWindow) return;
  if (e.data?.sagebrush === "ready") f.contentWindow.postMessage({ sagebrush: "board", version: 1, text, name: "foo.board.json" }, "*");
});
</script>
```

(The `sandbox` attribute is a second lock: the page sandboxes itself.)
