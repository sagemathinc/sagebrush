# The arXiv proxy: `/arxiv/<id>` opens a paper's LaTeX source (design r8, #1879)

`https://sagebrush.space/arxiv/<id>` (for example `/arxiv/2611.26934`, `/arxiv/2611.26934v2`, `/arxiv/math/0211159`)
opens that paper's LaTeX source in the LaTeX editor. The paper is in the reader's own workspace, ready to read,
annotate and work on with an agent. Today the reader would download the `.tar.gz`, unpack it and upload the files by hand.

The design copies the GitHub proxy (`/gh/`, web/gh/source.ts). The site's Worker only serves the page and never
fetches arXiv. The reader's browser fetches the one source file, and everything is unpacked and kept in that
browser's workspace.

## 1. What arXiv allows, and what we measured

- **Source endpoint:** `https://export.arxiv.org/src/<id>[vN]`, the same as `arxiv.org/src/…`. Checked on Nov 23 2026:
  - it answers `Access-Control-Allow-Origin: *`, so a page can read it;
  - `Content-Length` is readable from the page; `Content-Disposition` (which names the version) and `ETag` (a
    SHA-256) are not, because no `Access-Control-Expose-Headers` is sent;
  - `/e-print/<id>` answers `301` to `/src/<id>` without CORS headers, so the page requests `/src/` directly;
  - old-style ids work (`/src/math/0211159`, a single gzipped file).
- **arXiv's terms of use** (info.arxiv.org/help/api/tou.html):
  - the legacy APIs (the Atom API, OAI-PMH, RSS): "no more than one request every three seconds", one connection
    at a time, across all machines;
  - do not "store and serve arXiv e-prints (PDFs, source files, or other content) from your servers", unless the
    copyright holder permits or the submission's license allows it;
  - "link to the abstract page"; don't imply arXiv's endorsement.
  - Programmatic use is pointed at export.arxiv.org.
- **Consequences:**
  - The **Worker never fetches, stores or serves a source.** It serves the page, as for `/gh/`.
  - The fetch is the reader's own download, one per paper they open, from their browser (the same request as
    clicking "TeX Source", just unpacked for them). It goes to export.arxiv.org.
  - **Identification:** a page can't set `User-Agent`, and `Referer` isn't guaranteed. The CORS request always
    carries `Origin: https://sagebrush.space`, which is what arXiv can see. A contact for arXiv goes on the
    `/arxiv/` page itself.
  - **Which limit applies:** the one-request-per-3-s rule is for the legacy APIs (Atom, OAI-PMH, RSS). `/src/` is
    the per-paper download a reader gets from "TeX Source". v1 makes no legacy-API request at all (§5). The `/src/`
    fetch is one person's download of one paper they chose to open, so it is not a harvesting client that needs a
    worldwide limit. We pace it anyway, as courtesy, and say plainly that the pacing covers one browser only:
    - at most one source fetch at a time and one start every 3 s, across that browser's tabs (`navigator.locks`
      plus a timestamp in `localStorage`);
    - the unpacked copy in the workspace is the cache. Opening `/arxiv/<id>` again opens that copy and fetches
      nothing.
  - No prefetching, no listing, no crawling: a fetch happens only when a person opens one paper. No contact with
    arXiv is needed for v1 (§8, William): it is a browser-local, direct fetch. Should arXiv prefer `arxiv.org/src/`
    for this traffic, it's a one-line change.
- **Metadata with no CORS:** the license and the latest version are not readable by a page. The Atom API has
  neither header; OAI-PMH (oaipmh.arxiv.org) has `<license>` but no CORS. See §5 for how the license is handled
  without a server fetch in v1.

## 2. The address

- `parseArxiv(rest)`, like `parseGh`, accepts:
  - a new-style id `YYMM.NNNN` (to 1412) or `YYMM.NNNNN` (from 1501), with an optional `vN` (1 to 999);
  - an old-style id `archive[.SC]/YYMMNNN[vN]` (archive from arXiv's fixed list, for example math, hep-th or
    cond-mat; a subject class is accepted and dropped from the request);
  - a pasted `arxiv.org/abs/…`, `/pdf/…` (with or without `.pdf`), `/src/…` or `/e-print/…` URL.

  Anything else gets "That isn't an arXiv paper id."
- Only the parsed, canonical id goes into the request URL (`/src/` plus the id, percent-encoded per segment). Nothing
  else from the address does, so there's no path or host injection.
- `/arxiv/<id>` stays a stable link that others can share. It names the paper, not anyone's copy.

## 3. The three source shapes, decided by bytes

The request is `GET`, `credentials: "omit"`, `redirect: "error"`, `referrerPolicy: "strict-origin"`. The response
must be `200`. A `Content-Length` over the download cap (§4) is refused before reading. An absent one is allowed,
because the running count over the body enforces the cap either way, and stops the read there even if the length
was wrong.

- **gzip** (`1f 8b`): decompressed by the bounded inflater (§4), counting output against the total and ratio caps
  before any of it is kept. Then:
  - **a tar archive:** the first 512-byte block is a valid tar header (its checksum matches; ustar, GNU or v7, since
    old arXiv sources are often v7 tars). It's unpacked by the tar reader (§4);
  - **otherwise, a single file:** arXiv's single gzipped `.tex`. It's saved as `main.tex` (a fixed name, never one
    taken from the id or the archive) if it's UTF-8 or Latin-1 text with `\documentclass` or `\documentstyle`. The
    per-file cap (§4) applies to it as to a tar member.
    Otherwise nothing is saved and the page says "arXiv sent a source format Sagebrush can't open yet", with the
    abstract link.
- **PDF** (`%PDF-`): a PDF-only submission, with no source. Nothing is saved. The page says "This paper has no LaTeX
  source on arXiv" and links to the abstract page and the PDF on arxiv.org. The PDF isn't kept: we link, as arXiv
  asks.
- **Anything else** (an HTML error page, a withdrawn paper): the same page, saying arXiv didn't send a source, with the
  abstract link. `404` says "No such paper on arXiv". `429`/`503` say arXiv asked us to wait, with no retry loop.
- A real PDF-only id and a withdrawn id get recorded as test fixtures before the code (only the first bytes and the
  headers matter), so these branches are tested against what arXiv actually sends.

## 4. Safe extraction (untrusted input)

A new strict, bounded tar reader, `web/tar/read.ts`, in the style of `web/zip/read.ts`: pure TypeScript, a
`TarError` with a stable `code` for each refusal, and nothing trusted that the archive declares. Any malformed
header, including one for an entry that would be skipped, refuses the whole archive.

- **Where it runs:** in a dedicated Web Worker, streaming. The response body goes through the bounded inflater into
  the tar reader, block by block, and is never held whole. A Cancel button and leaving the page abort the fetch,
  terminate the worker and drop everything.
- **The bounded inflater (LIMITS L1):** `web/tar/inflate.ts`, a small pure-TypeScript gzip (RFC 1952) and DEFLATE
  (RFC 1951) decoder. It reuses `web/zip/crc32.ts` for the trailer's CRC. `DecompressionStream` is not used,
  because it promises no bound on an output chunk.
  - **Network reads are bounded at the allocation:** the body is read with a BYOB reader
    (`body.getReader({ mode: "byob" })`) into two 64 KiB buffers. A read detaches the buffer it was given, so the
    next read reuses the buffer the result returns. The browser never hands us a chunk we didn't size. This bounds
    the memory the page manages; the browser's own network buffering is outside it. Where a browser has no BYOB reader for a fetch body, the import
    is refused with "This browser can't open arXiv sources yet", rather than falling back to unsized chunks.
  - Compressed input goes from those buffers to the inflater in slices of at most 1 KiB, with no copies (views into
    the same buffer). The buffer isn't refilled until the inflater has consumed it.
  - Output goes into a fixed 1 MiB slab. The inflater is resumable: when the slab is full it stops mid-block, the
    slab is counted and drained, and it continues. So the slab, not the slice, bounds live output. (DEFLATE expands
    at most about 1032:1, so a 1 KiB slice could otherwise give slightly over 1 MiB.) The 32 KiB window is fixed
    too.
  - Every output byte is counted against the per-file, total and ratio caps **before** it is retained or written.
    A refusal happens at the first byte over, not after a chunk.
- **Every byte and entry counted:**
  - every decompressed byte, including headers, padding, skipped entries' data and anything after the
    end-of-archive marker, counts against the total and ratio caps;
  - every header block counts against the entries cap, files and everything else alike, so a million empty headers
    stop at the cap;
  - **completion is required:** the gzip stream must end normally. The inflater checks the trailer's CRC and length,
    and an error there (truncated, a corrupt trailer) refuses the import. The tar must have its end marker.
    Data after the marker must be zero padding and counts against the caps; anything else refuses. A second gzip
    member after the first refuses. Nothing is published before the stream ends and
    every check passes.
- **Memory and time (LIMITS L1):** the live peak is accounted, not guessed:
  - **retained:** kept files' bytes, each in one `Uint8Array` sized from the checked header and filled as counted.
    At most the expanded cap (100 MiB) in all; a byte that would pass it is refused before it's stored;
  - **buffers:** exactly two 64 KiB network buffers (BYOB, reused), the 1 MiB output slab, the 32 KiB window, and
    pax or GNU metadata (at most 4 KiB each, L2);
  - **text:** main-file detection scans bytes, not strings: `\documentclass`, `\documentstyle`, `%` comments and
    `\input` arguments are ASCII, so no `.tex` is decoded to UTF-16. Only a `00README.json` or `00README.XXX` hint
    is decoded, at most 64 KiB (128 KiB as UTF-16, L2);
  - **the hand-off:** files go to the page with transfer, not copies, and are written one at a time; each reference
    is dropped once its write is done. While a file is being written, the workspace's own copy adds at most one file
    (64 MiB);
  - **so the admitted peak** (approximate accounting of the page's buffers; entry objects, paths and parser state
    come on top) is at most 100 MiB retained, plus 64 MiB during one write, plus about 1.3 MiB of
    buffers and 128 KiB of text, about 166 MiB. Admission refuses early: the running total is checked before each
    byte is kept, against that budget;
  - **deadlines:** the whole import at most 120 s, and at most 30 s without a byte. Either aborts. The per-browser
    lock (§1) is held from the fetch until the import commits (the rename) or aborts, and is released on every way
    out.
- **Entry types:**
  - regular files (`0`, NUL, and v7's) and directories (`5`) are kept;
  - links (`1`, `2`), devices, FIFOs, contiguous files (`7`), GNU sparse (`S`), GNU volume and multi-volume
    headers (`V`, `M`) and unknown types are skipped and listed ("skipped: a link"); nothing is ever followed;
  - sparse pax entries (`GNU.sparse.*`) refuse the archive.
- **Sizes:** the octal size field is at most 11 digits, giving a safe integer; base-256 sizes are refused. A pax
  `size` must be a decimal safe integer. Each is checked against the per-file and remaining-total caps before
  anything is read.
- **pax and GNU long names:**
  - a pax `x` header's declared size is checked before anything is allocated: at most 4 KiB, or the archive is
    refused (L2). Each record is `"<len> <key>=<value>\n"`, where `<len>` is decimal and exactly the record's byte
    length, and anything else refuses;
  - only `path` and `size` are read from `x`; `g` (global) is ignored entirely, never applied;
  - a GNU `L` payload's declared size is checked before anything is allocated, read or decoded: at most the
    workspace's longest path in UTF-8 bytes (`MAX_PATH`), and never over 4 KiB (L2);
  - an `x` header or a GNU `L` applies only to the next entry; two in a row refuse;
  - precedence: pax `path`, then GNU `L`, then the ustar prefix plus name.

  The effective name is checked after every override.
- **Names:**
  - UTF-8, NFC-normalized. A leading `./` and a directory's trailing `/` are removed before the checks, and the
    root entry `./` alone is ignored;
  - refused: empty, a NUL or control character, a backslash, absolute (`/`, a drive letter), an empty, `.` or `..`
    segment, deeper than the workspace's `MAX_DEPTH`, or a segment over `MAX_NAME`;
  - the workspace's own name rules apply too: its lookalike check (`make()`'s `lookalike`) is run over the whole
    list before anything is written, so two names it would treat as the same refuse the archive;
  - a file whose path is also a folder's prefix (`a`, and `a/b`) refuses the archive; an exact duplicate does too.

  Paths are then joined under the staging folder with `normPath`, and the result must stay inside it (checked after
  normalization).
- **Caps** (accepted by LIMITS, in bytes):
  - **download:** 50 MiB ($50 \cdot 2^{20}$ bytes), by `Content-Length` and by the running count;
  - **total expanded:** 100 MiB (every decompressed byte, as above), an independent backstop to the ratio;
  - **per file:** 64 MiB (the GitHub proxy's `FILE_MAX`), for tar members and the single-`.gz` `main.tex` alike;
  - **headers:** 5,000 tar headers of any kind;
  - **kept regular files:** 2,000;
  - **created entries (L3):** at most 5,000 workspace entries, counting every file and every folder the import would
    make, including the implicit ancestor folders that no header names. The whole set of paths with their ancestors
    is computed and counted before anything is written;
  - **expansion ratio (L4):** decompressed bytes at most 100 times the compressed bytes **the inflater has actually
    consumed**, checked at every output byte. It is deterministic: network read-ahead (bytes fetched but not yet
    consumed) earns no credit, so the same archive refuses at the same byte whatever the fetch chunking.

  Any cap stops the whole import: no copy is published (only the staging folder may appear briefly, then is
  removed), and the page says which cap was hit, with the abstract link.
- **Atomic import:**
  1. Files are written into a fresh staging folder, `/arXiv/.importing-<24 hex>/`, that only this import knows,
     with the workspace's exclusive `create`. They count against its limits like any upload, and each entry gets
     its trusted origin (§5) as it is made.
  2. Publication is one workspace call, `publishImport(staging, dest, expected)`. It runs holding the workspace's
     exclusive lock, so no write, create, move or rename can land between its check and its move. Inside the lock:
     - it checks that the staging folder's descendants are exactly the entries the import made: the same paths,
       each with this import's origin identity, and each file's revision and SHA-256 as written. Anything added,
       removed, moved or edited meanwhile (the folder is visible, so a person or agent could touch it) aborts the
       import;
     - it renames the staging folder to the destination in the same locked section. The destination must not exist
       (an exclusive move).
  3. The destination is `/arXiv/<id>/`, or for "Fetch again" and for a non-matching folder already there (§5),
     `/arXiv/<id> (fetched <date>)/`. If that name is taken too (two imports in the same minute), ` 2`, ` 3`… is
     added, chosen inside the same locked section, so concurrent imports can't collide.
  4. A failure at any point removes only that staging folder, never anything else.

  The staging folder name is shown in Files while it exists, so an interrupted import is visible and can be
  removed.
- **Main-file detection, as arXiv's AutoTeX does:**
  1. `00README.json`: a source with `"usage": "toplevel"` (the first one if several);
  2. else `00README.XXX`: a `toplevelfile` line;
  3. else every `.tex` file with `\documentclass` or `\documentstyle` outside comments. If one, it's the main file;
     if several, the one no other file `\input`s or `\include`s, then the first by name (arXiv's order), and the
     editor's file list shows the others.

  A name from a 00README is only a hint. It must equal, after the same normalization, a regular `.tex` file this
  import kept; otherwise it's ignored and step 3 decides. A hint file over 64 KiB is ignored unread (L2). A
  `00README.json` is parsed with a bounded parser: depth at most 8 and at most 1,000 values; anything over is
  ignored, falling back to step 3.

## 4b. After the import: the source is still untrusted

- **The LaTeX build: provenance plus path confinement** (SEC H1). The engine never reads files itself and runs no
  shell; it gets a snapshot the page reads (web/latex/inputs.ts). Today `\input` and `\includegraphics` may go up
  with `..` and use a leading `/` for the workspace's top (images.ts `root`). For an arXiv-origin document:
  - **The origin identity** is the whole immutable record the import set: `{arxiv, importId, sha256, fetched}`,
    where `importId` is 24 random hex characters per import. Two copies of the same paper have different
    identities, and a duplicate of a copy is a new identity (§5).
  - **The root:** the document must have an ancestor folder marked `origin.root` whose complete origin identity
    equals the document's own. That folder is the build's root.
    - With no such ancestor, the build is refused: "This file came from arXiv and is no longer inside its copy, so
      Sagebrush won't build it." There is no fallback to the surrounding folder or the workspace's top.
    - So a `paper.tex` moved into `/private/`, a nested folder moved or duplicated elsewhere, and a paper A file
      moved under paper B's root all refuse.
  - **Every input:** every file the build reads must be inside that root and carry the exact same origin identity:
    - `\input` and `\include`;
    - graphics;
    - `.bib` and `.bbl`;
    - `.sty` and `.cls`;
    - any later resolver.

    `..` above the root and a leading `/` are refused. A file in the root without that identity is treated as
    absent, and the build log says why ("not part of this arXiv copy"). So a personal file moved into the copy isn't
    read, and neither is a file from another paper's copy.
  - **Adoption:** a file the person moves in becomes readable by the build only through an explicit "Make part of
    this arXiv copy" action. It says that the file then shares the copy's limits: browser-local, never shared
    publicly. Files created inside the copy inherit its identity already (§5).
  - **Imported files read by any other document:** a build whose main document has no arXiv origin, but which
    would read any file with an arXiv origin (`\input` of an imported `.tex`, `.sty` or `.cls`, or a figure), is
    refused: "This document uses files from an arXiv copy. Open it inside that copy to build it."
    - Otherwise the imported TeX would run under the reader's root and could `\input` their private files: the host
      can't tell which file asked for a read.
    - The check runs as each input is resolved, before its text is given to the engine.
  - **Atomic reads, an immutable snapshot:** each input is read with one workspace call that returns the entry
    (path, origin identity, revision) and its bytes from the same IndexedDB transaction. The origin check is made
    on that returned entry, not on an earlier lookup, so a move or replacement between resolving and reading can't
    swap in another file: the bytes read are the bytes whose provenance was checked. The engine gets an immutable
    snapshot of those bytes (it never reads the workspace).
  - **Build outputs keep the restriction:** everything a build of an arXiv-origin document produces (the PDF, the
    log, SyncTeX, auxiliary files) carries the same origin identity wherever the app writes it, inside the copy or
    elsewhere. Every app flow that takes a build result checks it like any entry:
    - saving it to the workspace;
    - attaching it to a chat or message;
    - sharing or publishing it;
    - a server-side export.

    Malicious TeX could reproduce the source in its PDF or log, so its outputs are treated like the source.
    Downloading the PDF to the person's own computer stays allowed, as for the source.
  - The existing bounds (`INPUT_BOUNDS`) apply unchanged.
- **Agents:** an agent works on the reader's behalf, under the reader's grant and Allow cards, as for every file.
  - A local agent sends file contents to the reader's own model account. That's the reader using their copy, as
    they could with the downloaded tarball, not Sagebrush storing or serving it.
  - The notice telling agents that `.tex` comments and the 00README are the author's words, not instructions, is a
    mitigation, not a boundary. The boundary is the existing grant and Allow model, which this design doesn't
    loosen.
  - The trusted origin (§5) is workspace metadata the agent can read but not set.

## 5. The reader's copy, where it lives, and the license

- **Where:** `/arXiv/<id>/` (for example `/arXiv/2611.26934v2/`, `/arXiv/math-0211159/`; old-style `/` becomes `-`).
  - Versions: a versioned link gives a versioned folder. An unversioned link gives `/arXiv/<id>/`, "the latest
    when fetched", because the version isn't readable from the page (§1). The folder's notice and the editor's
    header say so with the time: "The latest version on arXiv as of Nov 23, 2026, 5:26 PM".
  - Opening the link again opens the existing copy, with the reader's edits, but only if the folder at
    `/arXiv/<id>/` is a trusted root (`root: true`) whose origin's `arxiv` equals that canonical id. A folder there
    without that (made by hand, or moved in) isn't a cache hit: the import goes to
    `/arXiv/<id> (fetched <date>)/` instead, and nothing of the existing folder is read.
  - **Fetch again** never replaces anything. It imports into `/arXiv/<id> (fetched <date>)/` beside the old copy,
    and says whether the bytes changed (by SHA-256).
- **Trusted origin:** each entry the import makes carries an `origin: {arxiv: "<id>", importId, sha256, fetched}`
  field in the workspace's own entry record, beside `made` (api.ts). `importId` is 24 random hex characters, one per
  import. The import's top folder also has `root: true`. It is set only by the arXiv import, inside the workspace, and
  no file contents can set it: an archive's own `.arxiv.json` or 00README is just a file. No file holds it, so
  deleting or editing a file in the folder doesn't remove it. Propagation:
  - **write** (an editor save, an agent's rewrite) keeps the entry, so it keeps its origin;
  - **rename and move** carry it unchanged, as they carry `made`;
  - **duplicate** of a whole copy (its root) gives every duplicated entry one new `importId`, consistently: a new
    copy that builds on its own. Duplicating anything less than the root carries the origin without `root`, so
    the duplicate has no matching root and doesn't build (§4b), though it stays browser-local and unshareable;
  - **create inside a folder that has an arXiv origin** gives the new entry the same origin. That covers what
    agents and the person make in the copy (notes, notebooks, generated files);
  - **text copied elsewhere** (pasted into another file, or written by an agent outside the copy) isn't tracked. No
    taint tracking of contents is attempted.
- **Threat model:** the policy keeps a reader from publishing a paper's source by accident, and keeps Sagebrush
  from storing or serving the fetched files. Sagebrush's upload boundaries check the origin of every entry they
  would send, descendants included, so sharing a personal folder that contains an arXiv copy is refused too:
  - sync;
  - share and publish;
  - the chat mirror's file attachments;
  - any server-side export.

  Each of these checks is bound to the bytes it sends. The outbound payload is taken as an immutable snapshot:
  each entry's origin and its bytes come from one IndexedDB transaction (as for build reads, §4b), the check is made
  on that snapshot, and exactly those bytes are sent. A queued upload or a retry keeps its snapshot and never
  re-reads the path, so replacing a file after the check can't change what goes out.

  It does not stop a person, or an agent they direct, who copies the text into files outside the copy and shares
  those (nothing can without taint tracking). We say so in the folder notice.
- **Sync (ruled, §8):** arXiv's terms forbid storing and serving source files from our servers, and they
  name no private-account exception. Workspace sync stores the person's files on Sagebrush's servers and serves
  them back to their own devices.
  - **v1:** entries with an arXiv origin are local to the browser. Sync skips the whole origin subtree (blobs, entry
    metadata, versions), and the folder notice (below) says so.
  - This needs a sync exclusion by entry origin, which the sync owner adds. Until it exists, the proxy ships behind
    the DEV flag. It goes PROD once tests show that no blob, metadata body or attachment of an arXiv-origin entry
    reaches the server.
  - With a permissive license (v2 metadata), sync could include them.
- **Public sharing respects the license, failing closed:**
  - a share, publish or export-to-share that includes any entry with an arXiv origin is refused unless that
    origin's license is permissive and recorded. In v1 the license is never recorded, so it is always refused. The
    reason states our policy, not the paper's permissions (share, publish and server export alike): "Sagebrush
    hasn't verified this paper's license, so sharing this copy is unavailable. View the paper and its license on
    arXiv." The last sentence links to the abstract page. A download to the person's own computer is still allowed:
    that's their copy, as from arXiv.
  - Permissive means CC0, CC BY or CC BY-SA. The arXiv non-exclusive license and the NC/ND licenses are not.
  - When sharing is allowed (v2), the share adds attribution and the license notice: a `LICENSE-arXiv.txt` with
    the license URL, the abstract link and "Modified" if any file changed. The share page shows the same.
- **v2 (needs a ruling, gated separately):** a Worker metadata endpoint `/api/arxiv/meta/<id>` that reads only OAI-PMH metadata
  (license and version, CC0 data, never an e-print).
  - It is identified by a `User-Agent` with a contact, and cached per id and version. The license must be for the
    exact fetched version (an unversioned copy can't be shared until its version is known).
  - The attribution added to a share must meet the license, not just link to it: authors, title, the license, and
    "Modified" with what changed. Sharing under CC BY-SA must keep the adaptation under CC BY-SA. COPY and SEC
    review that text then.
  - It is paced to one request every 3 s, one connection at a time, worldwide, through one Durable Object that
    holds the slot until the response is fully read. This endpoint is our only legacy-API consumer.
- **Attribution:** the folder notice and the editor's header link to the abstract page ("from arXiv:<id>"), with
  no wording that implies arXiv endorses Sagebrush.
- **The folder notice** (COPY), shown at the top of the copy's folder in Files and in the editor's header:

  > From [arXiv:2611.26934v2](https://arxiv.org/abs/2611.26934v2), fetched Nov 23, 2026, 5:26 PM.
  > Saved only in this browser. Your edits here aren't synced. Download a copy to keep it on your computer.
  > Renaming or duplicating these files keeps the sharing restriction. Text copied into another file isn't tracked.

  For an unversioned link the first line reads "From arXiv:2611.26934 (latest when fetched), fetched Nov 23, 2026,
  5:26 PM." The notice says nothing about agents: their access is the normal grant and Allow flow (§4b).

## 6. The route: reusing `/gh/`

- **The Worker:** a `handleArxivPage` beside `handleGhPage` (web/site/src/preview.ts). `/arxiv/*` serves the same
  static page that opens LaTeX, `noindex`, with an `arxivPolicy(csp)` like `ghPolicy` that adds `connect-src
  https://export.arxiv.org` and nothing else. `_headers` gives `/arxiv/*` the same policy. The Worker makes no
  arXiv request (v1).
- **The page:** `web/arxiv/source.ts` (parse, fetch, the shape decision) and `web/tar/read.ts` (the reader), then
  the existing workspace `create` and the LaTeX editor's `/?tex=<fid>` for the main file. A progress line shows
  "Fetching from arXiv… / Unpacking… / Opening main.tex".
- **The app:** the desktop app has no `/arxiv/` route yet (like `/agents/`). Not in v1.

## 7. Tests (planned; TESTS lane)

- **`parseArxiv`:** each id form and URL form; versions; refusals (`../`, a bad archive, a host, too many digits).
- **The tar reader** (fixtures built in the test):
  - each entry type;
  - pax and GNU long names;
  - each name refusal;
  - NFC duplicates;
  - a header checksum;
  - each cap at its exact edge and one past it;
  - a gzip bomb stopped by the ratio cap while it decompresses, not after;
  - 10,000 empty headers stopped by the entries cap;
  - v7 headers, pax record-length mismatches, two pax headers in a row, base-256 and unsafe sizes, sparse entries;
  - prefix conflicts and lookalike names;
  - trailing data after the end marker.
- **The shapes:** a tar.gz, a single .gz (text and not text), the recorded PDF-only and withdrawn responses, and
  404/429.
- **Main-file detection:** `00README.json`, `00README.XXX`, one and several `\documentclass` files, a commented-out
  one.
- **The page, with a local stand-in for export.arxiv.org:**
  - one fetch per open; reopening fetches nothing;
  - the 3 s pacing across two tabs;
  - nothing written on a refusal;
  - the main file opens in the editor;
  - the share refusal for any entry with an arXiv origin, including after a rename, a duplicate and the folder's
    `.arxiv.json` being deleted;
  - an interrupted import leaves only its staging folder, and a failure removes only that;
  - `\input{/x}`, `\input{../../x}`, a `.bib` and a `.sty` above the root are refused by the build, and the build
    still works after the whole copy is renamed or duplicated (the duplicate as a new identity);
  - SEC H1's negative rows, each refusing:
    1. `paper.tex` moved into `/private/` (no matching root: the build is refused, and `/private/notes.tex` is
       never read);
    2. a nested subfolder of the copy duplicated into a personal folder (no matching root: refused, its new
       siblings never read);
    3. a personal file moved into the arXiv root (inside the root but without the identity: treated as absent,
       never read), and readable after "Make part of this arXiv copy";
    4. a document from paper A moved under paper B's root (B's root doesn't match A's identity: refused), and a
       paper B file `\input` by a paper A document (wrong identity: absent);
  - the import folder deleted: the remaining moved files refuse to build;
  - sharing a personal parent folder that contains an arXiv copy is refused;
  - for sync, a chat attachment, a share and an export: a personal file replaced by an arXiv-origin file (or a build
    output) between the check and the send goes out as the checked snapshot's bytes or not at all, never as the
    replacement; a queued retry resends its snapshot;
  - a personal document that `\input`s an imported `.tex` (which would `\input{/private/notes}`) is refused before
    the imported text reaches the engine;
  - an edit, create, move or rename aimed at the staging folder while `publishImport` holds the lock waits, and
    one before it makes the publication abort (the revision or hash differs);
  - two imports of the same id in the same minute get different destinations;
  - with the BYOB reader unavailable (a stub), the import is refused, not run on unsized chunks;
  - a personal file put at an input's path between resolution and read (a test hook in the workspace) is never
    given to the engine: the atomic read's entry has the wrong identity;
  - a build's PDF and log carry the origin; saving the PDF outside the copy keeps it; attaching it to a chat and
    sharing it are refused; downloading it is allowed;
  - a folder made by hand at `/arXiv/<id>/` isn't a cache hit;
  - a change to the staging folder during an import aborts it;
  - a GNU long name over the bound is refused before it's read; a single-`.gz` source over the per-file cap is
    refused;
  - LIMITS rows, each exactly at the cap and one past it:
    - pax and GNU metadata at 4 KiB and 4 KiB + 1 (refused before allocation);
    - a 00README at 64 KiB and 64 KiB + 1 (ignored, TeX detection used), and JSON at depth 8/9 and 1,000/1,001
      values;
    - created entries at 5,000 and 5,001 counting implicit ancestor folders (an archive of deep paths whose
      headers alone are under the cap);
    - kept files at 2,000 and 2,001;
    - the per-file, expanded and download caps;
    - the output slab and queue peaks, measured in the worker: never more than one 1 MiB slab and two 64 KiB
      network slabs live;
  - the ratio: the same bomb refuses at the same output byte when the stand-in server sends it in 1-byte,
    4 KiB and whole-body chunks;
  - the lock is held until commit or abort (a second tab's import waits until then);
  - the share, publish and server-export refusals' exact text;
  - create inside the copy inherits the origin; write keeps it;
  - a truncated gzip, a corrupt trailer, concatenated members, a missing tar end marker, non-zero trailing data;
  - the import deadline and the idle deadline;
  - sync skips entries with an arXiv origin;
  - the Worker answers `/arxiv/*` without any outbound request.

## 8. Rulings (Nov 23 2026)

1. **Sync:** arXiv copies are local to the browser in v1, behind the DEV flag until the sync owner adds the
   origin-based sync exclusion; then PROD. Not waiting on arXiv.
2. **Sharing:** no public sharing in v1 (fail closed). The metadata endpoint and the Durable Object pacing are v2,
   gated separately.
3. **Unversioned links:** `/arxiv/<id>` is "the latest when fetched", and the reader is shown the fetch time.
4. **Contacting arXiv:** William: no contact needed for v1 (browser-local, a direct fetch).
5. **Caps:** LIMITS accepted the numbers, in bytes (50 MiB, 100 MiB, 64 MiB, 5,000 headers, 2,000 files), with
   repairs L1 to L4 (§4): a bounded-output inflater, metadata and hint bounds, implicit folders counted, and a
   deterministic ratio.
6. **SEC H1:** the build needs provenance plus path confinement (§4b): a matching marked root, every input with
   the same origin identity, no fallback, and explicit adoption.

7. **COPY:** the sharing refusal states our policy ("Sagebrush hasn't verified this paper's license…"), and the
   folder notice's text is in §5.

Lanes for this revision: SEC (H1 in §4b and §5, and L1/L2 at the extraction boundary), LIMITS (L1 to L4 in §4),
COPY (the refusal and the folder notice in §5).
