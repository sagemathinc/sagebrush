# Security: no script but ours

*October 12, 2026.* William's requirement: Sagebrush should be software where
XSS attacks are not possible, even at the cost of functionality.

## What is at stake

sagebrush.space keeps a person's notebooks, boards and files in their
browser (IndexedDB) for that origin. A script that ran on the origin could:
- read all of it;
- change it;
- send it anywhere.

Untrusted content reaches the page in these ways:
- **Documents:** notebooks (`.ipynb` files, shared links) and boards (`?doc=`
  any URL, files, pastes, agents).
- **Code output:** what Python code displays (Markdown, HTML, SVG, LaTeX,
  widgets).
- **Code itself:** Python code, which runs in a Web Worker on the same origin.

## The rules

1. **Markup from content is never trusted.** Every place content becomes
   HTML goes through one of these:
   - Markdown (web/markdown.ts): its raw HTML through web/safe-html.ts; links
     and images keep only harmless URLs.
   - SVG output: an element and attribute allowlist (notebook.js `safeSvg`).
   - Math: KaTeX, with `trust` off (no `\href`, `\url`, `\htmlClass`, ...).
   - HTML output (`text/html`, from `IPython.display.HTML`, tables):
     web/safe-html.ts.
   - Text: `textContent`, or escaped.
2. **Restricted HTML** (web/safe-html.ts) is the formatting Jupyter notebooks
   use: colored spans, bold and underline, tables, images with a width,
   `<br>`, details. The fragment is read as tags and text, and every tag kept
   is written out again from scratch: an allowed name, allowed attributes,
   values checked after their entities are decoded, then escaped. It drops:
   - comments, and `<script>`, `<style>`, `<template>`, `<svg>`, `<math>` and
     the like, with their contents;
   - event handlers, `id` and `name` (DOM clobbering), and `class`;
   - `url()` and `expression()` in styles;
   - links and images other than http(s), mailto, relative links, `data:image`
     and notebook attachments.
3. **What code shows cannot load from other sites.** Markdown and HTML
   output, and `data:` images only in SVG output. Code can read a person's
   browser files (as in Jupyter, `open()` reads them), and an image's address
   is a way to send data away.
4. **Board documents are only data.** `cleanDoc` (web/board/doc.ts) makes
   every number a finite number, every text a string, every choice one of its
   values, and every color a color. It runs before a document is shown,
   whatever it came from.
5. **A Content-Security-Policy is a second line of defense.** web/build.ts
   writes it into `_headers` for `/`, `/board/*` and `/embed/*`. It allows
   scripts only from the site, and the pages' own inline scripts by their
   hashes, with no inline handlers, plugins, `<base>` or forms. Should markup
   ever get past rules 1–4, no script it brought could run. The Python
   worker's script has its own response, so it has no such policy: it
   compiles Python to JavaScript.
6. **Python cannot reach JavaScript.** Python objects expose only Python
   attributes (`constructor`, `__proto__`, `call` are AttributeErrors), there
   is no `js` module, and attribute names reach generated code only as JSON
   strings. Python has no network API.

## Found and fixed (October 12)

- **A hostile board could run script.** A board's positions were trusted to
  be numbers. A `?doc=` board whose `x` was a string of markup reached the
  print view's SVG markup through the edges' routes. Fixed by `cleanDoc`
  (rule 4). web/board/test-xss.mjs shows script ran before the fix.
- **Remote images in code output** were a way for code to send data away.
  Fixed by rule 3.

## Tests

- **test/safe-html.test.ts:** about 55 XSS payloads, including mutation-XSS
  and namespace confusion. Each is sanitized and then parsed by a
  spec-compliant HTML parser (parse5), alone and inside Markdown. Only
  allowed elements and attributes and harmless URLs may remain.
- **web/board/test-xss.mjs:** a board with markup and script in every field
  is shown, run (its code displays hostile HTML and Markdown), edited,
  printed and exported, and nothing runs. Also: the site's own pages run
  under their policy with no violation.

## Still to do

- An adversarial review of the Python sandbox, a search for a way from
  Python to JavaScript, by sagebrush-codex.
- The policy for the other pages (the atlas, the articles, /demo/).
- Whether a notebook opened from a share link should run code without asking.
  It does not today: loaded outputs are stale until run. Boards from `?doc=`
  do run their code on open, but their interpreter has no files.
