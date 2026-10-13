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
   - SVG output (notebook.js `safeSvg`): an element allowlist; elements and
     attributes judged by namespace and local name, never by the prefix the
     text chose (`x:href` is an XLink href). An attribute value or style
     declaration may name the picture's own ids, `url(#id)`; otherwise it has
     no backslash (CSS escapes), slash or colon, so nothing in it can name
     another site. `href` is a local `#id`, or for `<image>` an inline raster
     `data:` URL. The only CSS functions are transforms, colors and
     arithmetic (never `image-set()` and the like), and no property that
     takes an image or content (`background*`, `cursor`, `list-style*`,
     `content`, ...) is kept, as a style or an attribute. Only `aria-*` and
     `data-*`, which are text, may hold anything.
   - 3D scenes: their strings are set as DOM properties (`style.color`),
     never spliced into CSS text.
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
5. **A Content-Security-Policy is a second line of defense,** on every page
   (web/csp-policy.mts). web/csp.ts writes it into `_headers` for every
   static page (one rule per top-level directory, with the hashes of its
   pages' inline scripts; the build fails if a page is left without a policy
   allowing its scripts), and the atlas's Worker-rendered pages set it
   themselves (web/atlas/server.ts; its search box may submit to the site). It allows
   scripts only from the site and from Cloudflare's Web Analytics beacon
   (which the site's host adds to its pages), and the pages' own inline
   scripts by their hashes, with no inline handlers, plugins, `<base>` or forms. Should markup
   ever get past rules 1–4, no script it brought could run. The Python
   worker's script has its own response, so it has no such policy: it
   compiles Python to JavaScript.
6. **Python cannot reach JavaScript.** Python objects expose only Python
   attributes, there is no `js` module, and attribute names reach generated
   code only as JSON strings. Python has no network API. In detail
   (src/runtime/object.ts):
   - an attribute is an own property of the instance; nothing a JavaScript
     prototype has (`constructor`, `toString`) ever answers a Python
     attribute read, through any path, cached or not;
   - a store never runs a JavaScript setter: `__proto__` is stored as an own
     data property, an ordinary attribute as in CPython;
   - names starting with `$` are the runtime's own slots (`$cls`, `$m`): not
     readable, writable or deletable from Python, through any namespace:
     `getattr`, `setattr`, an instance's `__dict__`, `globals()` and a
     module's `__dict__`, `SimpleNamespace(**kw)`. This differs from
     CPython, where any string is a name;
   - an attribute-read site caches an instance attribute only for an object
     that has its class's own JavaScript prototype, and, for a list or dict
     subclass, only a name that is not on that prototype chain: a forged
     class tag can never make it answer with a JavaScript property;
   - an array's `length` and elements are its list's, never attributes;
   - text Python controls never becomes JavaScript source: a module's file
     name, which ends up in a `//# sourceURL=` comment, is percent-encoded
     (src/compile.ts `scriptName`), and the browser's eval refuses a name
     with a line terminator;
   - `__pyjs_host__` answers only an own function operation of the host named
     by a string, never an inherited JavaScript method (`constructor`,
     `toString`);
   - a subclass of a JavaScript-backed builtin (bytes, bytearray, complex,
     the lazy iterators, array.array) does not expose that layout's own
     implementation fields (bytes' `Uint8Array`, a reversed iterator's
     closure) as Python attributes; those names are the runtime's, like the
     `$` slots, hidden from access and `vars()`.

## Found and fixed (October 12)

- **A hostile board could run script.** A board's positions were trusted to
  be numbers. A `?doc=` board whose `x` was a string of markup reached the
  print view's SVG markup through the edges' routes. Fixed by `cleanDoc`
  (rule 4). web/board/test-xss.mjs shows script ran before the fix.
- **Remote images in code output** were a way for code to send data away.
  Fixed by rule 3.

sagebrush-daybreak's review of 983418b found six more, all fixed:
- **SEC-983-1, critical: Python reached JavaScript's `Function`.** An
  attribute read site, primed by an instance's own attribute, answered the
  next instance of a list subclass with an inherited JavaScript property
  (`Array`); a `__proto__` store then ran JavaScript's prototype setter, and
  `Function` followed. Raw JavaScript in the worker, which has the origin's
  IndexedDB. And a `?doc=` board runs its code on open.
- **SEC-983-2, critical: a newline in a module's file name** (Python controls
  it through `sys.path`) ended the `//# sourceURL=` comment and ran the rest
  as JavaScript.
- **SEC-983-3/4, high: SVG output loaded from other sites** through CSS
  escapes (`u\72 l(...)`) and an XLink href under another prefix (`x:href`).
  The same review found `image-set('...')` in a style worked too.
- **SEC-983-5, high: a 3D scene's label color** was spliced into CSS text:
  `red;background-image:url(...)` loaded from another site.
- **SEC-983-6, medium: the atlas, the articles and /demo/ had no policy.**

Its re-review of 18f5216 found two more, both fixed:
- **SEC-18F-1, critical: Python reached `Function` again.** `globals()`
  wrote the runtime's `$cls` and `$m` onto the module object, so a module
  could pass for a list subclass, prime an attribute-read site, and that
  site then answered a real list-subclass instance with a JavaScript
  property. From there, through a forged dict and a property subclass, to
  `Function`, in a board's worker. Fixed twice over (rule 6): no namespace
  takes a `$` name, and the cache checks the object's real prototype.
- **SEC-18F-2, medium: relative requests from SVG output** through
  `image-set('...')` and `cursor`: to this site only, but a way to put data
  in a request. Fixed by the function and property allowlists (rule 1).

Its re-review of 5deaa70 found one more, fixed:
- **SEC-5DE-1, critical: importing wrote a `$` slot.** A submodule became
  its parent's attribute with a raw property store, so a custom
  `sys.meta_path` loader plus an arbitrary `sys.modules` parent could write
  `$ctor` on a class or `$cls` on an object, forge a layout, and reach
  `Function`. Fixed three ways: a module's name is never a `$` name, the
  child is bound with `setattr` (so the reserved-name rule applies), and the
  attribute-read cache now returns a value only when it is the object's own
  property, so even a forged layout cannot leak an inherited JavaScript
  property. The own-property check on every cached read costs roughly half
  as much again on attribute-heavy Python; it is kept as the backstop that
  makes the whole class of cache escape impossible, not only the paths found
  so far.

Its re-review of 61c9cfe found two more, both medium (neither reached
`Function`), both fixed:
- **SEC-61C-1: `__pyjs_host__` called inherited host methods.** A
  Python-chosen op like `constructor` reached `Object` through the host
  object's prototype and returned a raw JavaScript object. It now answers
  only an own function operation named by a string.
- **SEC-61C-2: builtin subclasses exposed implementation fields.** A bytes
  subclass gave out its `Uint8Array`, a reversed-iterator subclass its raw
  closure. Each JavaScript-backed layout's own field names are now the
  runtime's, hidden from attribute access and `vars()` like `$` slots.

Its re-review of dd9b8cb, together with a review of my own of the code
written after a model fallback, found the SEC-61C-2 fix incomplete: each
place that listed or wrote an instance's attributes had its own rule. Three
medium findings, fixed together:
- **SEC-DD9-1: lookup tables matched inherited names.** `array("constructor")`
  passed `tc in SIZES` and handed out JavaScript `Object`; memoryview's
  formats and NumPy's dtype names had the same shape. Every string-keyed
  table in the runtime is now built with no prototype (`table()` in
  src/runtime/object.ts), so only its own entries are ever found.
- **SEC-DD9-2: `__getstate__` walked raw properties** and exported a layout's
  storage (a reversed iterator's closure, an array's typed buffer).
- **SEC-DD9-3: `__dict__` writes, assignment and deletion** reached a
  layout's storage, truncating or deleting it.

The structural fix: one function, `attrNames`, says what an instance's
attribute dict holds, and `__dict__`, `vars()`, `dir()`, `__getstate__` and
`del obj.__dict__` all use it; and `putAttr`, where every Python-named write
ends, refuses a layout's own field. `dir()` of a list subclass also no longer
lists its elements.

## Tests

- **test/safe-html.test.ts:** about 55 XSS payloads, including mutation-XSS
  and namespace confusion. Each is sanitized and then parsed by a
  spec-compliant HTML parser (parse5), alone and inside Markdown. Only
  allowed elements and attributes and harmless URLs may remain.
- **web/board/test-xss.mjs:** a board with markup and script in every field
  is shown, run (its code displays hostile HTML and Markdown), edited,
  printed and exported, and nothing runs. Its code items also try both
  escapes from Python to the worker's JavaScript (which would post to a
  BroadcastChannel the page listens on), and the notebook displays SVG and
  3D outputs that would load from another site, while every request is
  watched. Also: the site's own pages run under their policy with no
  violation. Against the site before the fixes it failed all of these.
- **test/security.test.ts:** the escapes, and the shapes around them, for
  every instance layout (list, dict, int and plain subclasses).
- **web/atlas/test-atlas.mjs:** the atlas's pages have the policy, and run
  (computing in the page included) without a violation.

## Still to do

- Further adversarial review of the Python sandbox (rule 6): it carries the
  most weight, since the worker has the origin's storage and a `?doc=` board
  runs its code on open.
- Whether a notebook opened from a share link should run code without asking.
  It does not today: loaded outputs are stale until run. Boards from `?doc=`
  do: safe only while rule 6 holds.
