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
   scripts only from the site, never another site's (no analytics beacon:
   security audit G-2), and the pages' own inline scripts by their hashes,
   with no inline handlers, plugins, `<base>` or forms. It says who may frame
   a page: only the site itself, and no one for the agents page, `/agents/`
   (G-1), with a matching `X-Frame-Options`; only the frame other sites show
   a board in (`/frame/board/`) may be framed by any page. Should markup
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
7. **An optional package set runs only from the bytes its id names (SEC-PKG-1).**
   Optional packages (optional/<name>/; plan-modular-packages-r4) are
   published as content-addressed sets, outside the core. They are reviewed
   first-party code, and the contract lint is not a sandbox for their
   Python. What is guaranteed is integrity and ownership, in every host
   (src/pkgset.ts):
   - a set's id is the SHA-256 of its index's exact bytes. It comes from the
     notebook's pin, or once from the site's `pkgset/latest.json`, never from
     the set itself;
   - the index pins every chunk by its whole SHA-256 and size, and every
     file by its SHA-256. A chunk's own header must name the package and
     kind the index gives it;
   - the index is parsed strictly: no duplicate keys, no `__proto__`,
     `constructor` or `prototype`, and bounded depth and sizes (`PKGSET_LIMITS`).
     It is admitted whole before anything changes;
   - nothing in a set can replace or extend a core, builtin or bundled
     module, or take a bundled package's directory;
   - a set's precompiled code is kept apart from the core's
     (`__SAGEBRUSH_PRECOMPILED__` is never written) and used only for that
     package's own files in that exact build;
   - a runtime has at most one set. Another needs a new interpreter.

   The service worker (web/sw.js) treats `/pkg/<sha256>.json` and
   `/pkgset/<sha256>.json` as content-addressed:
   - a response is used only if its bytes have the SHA-256 in its own path,
     from the network (no redirects followed) and from its cache alike;
   - it is always served as a response made there (200, JSON, no other
     headers);
   - it is kept in a cache of its own (`sb-pkg-v1`), never the build's,
     bounded by a ledger (64 entries, 256 MiB or a tenth of the quota, and
     never into the documents' reserve), with heartbeat pins only;
   - a Range request is never kept.

   The worker checks every byte against the index again, so a poisoned cache
   or a wrong answer can make an import fail, but never run other code.

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
  - **It is a switch** (`hardened` in src/runtime/object.ts), on by default.
    `SAGEBRUSH_HARDENED=0` in the environment, or `setHardened(false)` before
    any code is compiled, turns it off. Each read site is generated with or
    without the check, so off costs nothing.
  - **Measured** on an attribute-heavy loop (five attribute reads per
    iteration, 2 million iterations, Node): 0.165 s on, 0.108 s off, against
    CPython's 0.136 s.
  - **Both ways are tested:** CI runs test/security.test.ts with it off too.
    Every Python-level escape test passes either way, since the primary rule
    (a site is primed only by an object with its class's own prototype)
    holds. The TypeScript test of a forged object shows what it adds: off,
    the forged object gets JavaScript's `Function`.
  - **Whether to turn it off by default** waits on the separate runner,
    which makes any escape worthless (see "Still to do").

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

Its re-review of 2c5ccc1 found two more, both fixed:
- **SEC-2C5-1, critical: `__pyjs_run__` ran in any object's namespace.** The
  compiled code reads its globals as `$g[name]`, so a Python function as the
  namespace let `constructor` reach JavaScript `Function`. It now runs only
  in a module (null-prototype) or a dict (wrapped in a null-prototype
  namespace); anything else is a TypeError. This is the interactive/doctest
  runner, so it needed the same care as `exec`/`eval`.
- **SEC-2C5-2, medium: `_numpy.printopt` indexed its options with a Python
  key**, so `constructor` returned JavaScript `Object`. Its options table is
  now prototype-less, and it returns only its own keys.

Its re-review of bbb4432 found two descriptor-boundary violations, fixed:
- **SEC-BBB-1, high:** a built-in get/set descriptor (`getset_descriptor`)
  recorded no owner, so one fetched from `vars(cls)` could be applied to any
  receiver, reaching a JavaScript property of an opaque runtime object.
- **SEC-BBB-2, medium:** a built-in method fetched from `vars(cls)` could be
  bound to, or called on, an instance of another type and write that
  object's protected storage.

Built-in descriptors and methods now record their owning type (`GetSet.owner`,
`f.$owner`) and check the receiver first on every path: `__get__`, `__set__`,
binding, and a direct call of what `vars(cls)` returns (the receiver-checking
form). Normal attribute access and method calls are unchanged.

Its re-review of 15bfb45 found that fix incomplete: three more ways to reach a
built-in method unchecked, all high (none reached `Function`), fixed together:
- **SEC-15B-1: a bound built-in method's `__func__`** was the raw method, so
  `array("B").__imul__.__func__(bytes_subclass, 2)` rewrote an immutable
  bytes object's storage.
- **SEC-15B-2: keyword calls skipped the check.** The checking form's
  keyword adapter called the raw method (and a custom adapter, such as
  `SimpleNamespace.__init__`'s, was copied unchecked), so
  `str.encode(opaque_object, encoding="utf-8")` ran.
- **SEC-15B-3: class lookup used the class reached, not the method's owner.**
  It checked only on types without instances of their own
  (`ModuleType.__repr__` ran on anything), a str subclass's copies of str's
  methods had no owner, and one wrapper was cached for whichever class was
  reached first (`bool.bit_length(1)` then failed).

The structural fix (`selfChecked` in src/runtime/object.ts): a built-in
method has exactly one form Python may hold, made for its immutable owner and
cached on it, which checks the receiver on every way of calling it:
positionally, by keyword (`self=` included, once the arguments are bound),
and through its own keyword adapter. Class lookup, a class's `__dict__`,
`super()`, `function.__get__` and a bound method's `__func__` all give that
form; the raw method runs only where the receiver is known (an instance's own
attribute lookup), and is never handed to Python.

Its re-review of 65e998a confirmed that, and found two follow-ups, fixed:
- **CORR-65E-1 (correctness):** coroutine's `send`, `throw` and `close`
  were the generator's own methods, so through the class they now refused a
  coroutine. Coroutine has its own methods (doing what the generator's do).
- **HARD-65E-2 (hardening):** some builtin `__new__` made an instance of any
  class: int's, str's and float's by keyword (`int.__new__(StrSubclass,
  "10", base=16)`, a str subclass holding an int), and BaseException's,
  tuple's and frozenset's at all. Every builtin `__new__` but object's and
  type's (which make any class) is now an `allocator()`
  (src/runtime/types.ts): it makes only its own type's subtypes, checked on
  every way of calling it, as CPython's do.

A test now checks the structure for every builtin type: each method in its
dict is its own or an ancestor's, and its `__new__` is object's, type's, or
an allocator for it.

Its re-review of 8d6b54b found that the library compiled ahead for the
browser (sagebrush-precompiled.json) could be poisoned, fixed with two lows:
- **SEC-8D6-1, medium: a kept copy of code was trusted.** The service
  worker kept the precompiled library cache-first in CacheStorage, which any
  script of the origin can write, and its address named the build, not the
  bytes. So a transient escape into the worker could rewrite it and run again
  after a clean reload (daybreak showed it). The same held for the engine
  (cache-first) and, offline, for the page and the worker. Fixed twice over:
  - the service worker carries the SHA-256 of every file it keeps (web/build.ts
    writes them into sw.js, which no page script can change) and serves a kept
    copy only if it still has it, else drops it and fetches it again, or,
    offline, does not serve it;
  - the worker carries the precompiled library's SHA-256 (the library is
    compiled before the worker is built) and installs only bytes that have it.
- **PRE-8D6-2, low:** an entry is used only for the library file it was
  made from: its exact path in the library (not a sibling with the same
  prefix) and the library's own source (not a file of the same length).
- **BUILD-8D6-3, low:** web/build.ts checks that build/cli is the current
  sources' build (scripts/build-id.mjs, shared with build-cli.mjs), so the
  worker and the library compiled ahead always come from the same sources.

web/test-pwa.mjs rewrites the kept copies of the precompiled library, the
engine and (offline) the worker, and checks that none of them is used.

Its re-review of 522d311 found the bytes were checked but not the rest of
the response (SEC-522-1, medium): a script could keep the page's exact bytes
as a redirect, with a Refresh, or without its security headers (no
cross-origin isolation, no policy), and the service worker served that
response as kept. Now a kept copy counts only if it is a response the service
worker kept itself (same-origin, 200, not redirected, from its own address,
in this version's cache), and it is served as a response the service worker
makes: the verified bytes with the build's status, type and headers
(cross-origin isolation everywhere, the page's own policy), never the kept
response's. A copy that fails is dropped. The worker also checks the
engine's SHA-256 itself before running it (src/runtime/sha256.ts, as it
loads synchronously), as it does the precompiled library's. web/test-pwa.mjs
keeps the page's bytes without its headers, as a redirect, and with a
Refresh, and checks none of them is served, with the browser's HTTP cache
cleared so only the service worker can answer.

Since the load budget's split (web/lib-chunks.mts, web/lib-lazy.ts), the
browser's worker no longer embeds the Python library: it and the precompiled
modules come in chunks (a group of library files' sources, or their compiled
code), fetched when a mode starts or a module is first imported. Each chunk
is code, checked the same way: the worker carries the manifest (each chunk's
SHA-256, and which group each library file belongs to), installs a chunk only
if its bytes have that hash, and takes from it only its own group's files and
modules, so a chunk can't stand in for another. The sources are required (an
import of a module whose chunk can't be fetched or fails the check is an
error that says so); the compiled code is used when it is there. The service
worker keeps chunks under LAZY, verified like the rest; the runner's page
fetches only engine files and chunk names (lib/<group>.<kind>.<hash>.json)
for its worker. web/test-pwa.mjs rewrites a kept chunk of compiled code.

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

- The separate runner: Python in a sandboxed, opaque-origin frame on its own
  domain, with nothing worth stealing, so an escape from rule 6 gets nothing.
  Then the attribute-read backstop can be off by default.
- Further adversarial review of the Python sandbox (rule 6): it carries the
  most weight, since the worker has the origin's storage and a `?doc=` board
  runs its code on open.
- Whether a notebook opened from a share link should run code without asking.
  It does not today: loaded outputs are stale until run. Boards from `?doc=`
  do: safe only while rule 6 holds.
