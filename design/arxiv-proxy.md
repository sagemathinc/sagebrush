# The arXiv proxy: `/arxiv/<id>` opens a paper's LaTeX source (design r3, #1879)

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
  - No prefetching, no listing, no crawling: a fetch happens only when a person opens one paper. A question for
    arXiv, before launch (§8): whether they want this traffic from many browsers to go through
    `arxiv.org/src/` or `export.arxiv.org/src/`.
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

- **gzip** (`1f 8b`): decompressed with `DecompressionStream("gzip")`, counting output against the total and ratio
  caps as it comes out. Then:
  - **a tar archive:** the first 512-byte block is a valid tar header (its checksum matches; ustar, GNU or v7, since
    old arXiv sources are often v7 tars). It's unpacked by the tar reader (§4);
  - **otherwise, a single file:** arXiv's single gzipped `.tex`. It's saved as `main.tex` (a fixed name, never one
    taken from the id or the archive) if it's UTF-8 or Latin-1 text with `\documentclass` or `\documentstyle`.
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

- **Where it runs:** in a dedicated Web Worker, streaming. The response body goes through
  `DecompressionStream("gzip")` into the tar reader, block by block, and is never held whole. A Cancel button and
  leaving the page abort the fetch, terminate the worker and drop everything.
- **Every byte and entry counted:**
  - every decompressed byte, including headers, padding, skipped entries' data and anything after the
    end-of-archive marker, counts against the total and ratio caps;
  - every header block counts against the entries cap, files and everything else alike, so a million empty headers
    stop at the cap;
  - **completion is required:** the gzip stream must end normally. `DecompressionStream` checks the trailer and
    CRC, and an error there (truncated, a corrupt trailer) refuses the import. The tar must have its end marker.
    Data after the marker must be zero padding and counts against the caps; anything else refuses. Concatenated
    gzip members are refused if the decompressor rejects them. Nothing is published before the stream ends and
    every check passes.
- **Memory and time, honestly bounded:**
  - kept files' bytes are held once, each in one `Uint8Array` sized from the checked header, and moved to the page
    with transfer, not copied;
  - only `.tex` and `00README*` files are decoded to strings, for main-file detection, one at a time;
  - `DecompressionStream` doesn't promise a chunk size, so the cap is checked after each chunk and can be passed by
    at most one chunk. The tests measure the largest chunk in Chrome, Firefox and Safari. If any exceeds 1 MiB, the
    reader switches to a bounded JavaScript inflater that writes into a fixed buffer;
  - the planned peak is about twice the decompressed cap (the kept files, plus the workspace's own copy while it
    writes), about 200 MB at the proposed cap. LIMITS sets the cap with that in mind;
  - deadlines: the whole import at most 120 s, and at most 30 s without a byte. Either aborts, and the lock is
    released on every way out.
- **Entry types:**
  - regular files (`0`, NUL, and v7's) and directories (`5`) are kept;
  - links (`1`, `2`), devices, FIFOs, contiguous files (`7`), GNU sparse (`S`), GNU volume and multi-volume
    headers (`V`, `M`) and unknown types are skipped and listed ("skipped: a link"); nothing is ever followed;
  - sparse pax entries (`GNU.sparse.*`) refuse the archive.
- **Sizes:** the octal size field is at most 11 digits, giving a safe integer; base-256 sizes are refused. A pax
  `size` must be a decimal safe integer. Each is checked against the per-file and remaining-total caps before
  anything is read.
- **pax and GNU long names:**
  - a pax `x` record is `"<len> <key>=<value>\n"`, where `<len>` is decimal and exactly the record's byte length;
    each record and the header together are at most 4 KiB, and anything else refuses;
  - only `path` and `size` are read from `x`; `g` (global) is ignored entirely, never applied;
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
- **Caps** (the LIMITS lane's to set; proposed):
  - **download:** 50 MB, by `Content-Length` and by the running count;
  - **total decompressed:** 100 MB (every byte, as above);
  - **per file:** 64 MB (the GitHub proxy's `FILE_MAX`);
  - **entries:** 5,000 headers of any kind; kept files: 2,000;
  - **expansion ratio:** decompressed at most 100 times the compressed bytes read so far, checked as it grows.

  Any cap stops the whole import: no copy is published (only the staging folder may appear briefly, then is
  removed), and the page says which cap was hit, with the abstract link.
- **Atomic import:**
  1. Files are written into a fresh staging folder, `/arXiv/.importing-<24 hex>/`, that only this import knows,
     with the workspace's exclusive `create`. They count against its limits like any upload, and each entry gets
     its trusted origin (§5) as it is made.
  2. Then one `rename` makes the staging folder `/arXiv/<id>/` (§5).
  3. A failure at any point removes only that staging folder, never anything else.

  The staging folder name is shown in Files while it exists, so an interrupted import is visible and can be
  removed.
- **Main-file detection, as arXiv's AutoTeX does:**
  1. `00README.json`: a source with `"usage": "toplevel"` (the first one if several);
  2. else `00README.XXX`: a `toplevelfile` line;
  3. else every `.tex` file with `\documentclass` or `\documentstyle` outside comments. If one, it's the main file;
     if several, the one no other file `\input`s or `\include`s, then the first by name (arXiv's order), and the
     editor's file list shows the others.

  A name from a 00README is only a hint. It must equal, after the same normalization, a regular `.tex` file this
  import kept; otherwise it's ignored and step 3 decides.

## 4b. After the import: the source is still untrusted

- **The LaTeX build:** the engine never reads files itself and runs no shell. It gets a snapshot the page reads
  (web/latex/inputs.ts). Today `\input` and `\includegraphics` may go up with `..` and use a leading `/` for the
  workspace's top (images.ts `root`).
  - The import marks its top folder's entry with `origin.root: true`. For a document whose entry has an arXiv
    origin, the build's `root` is its nearest ancestor folder carrying that mark, found when the build starts. That
    stays right after the folder is renamed or duplicated, because the mark moves with the entry.
  - **Failing closed:** an arXiv-origin document with no marked ancestor gets its own folder as the root, with `..`
    and a leading `/` refused. That covers a single file moved out, a nested subfolder duplicated elsewhere, and
    the import folder deleted. The build can still read what sits beside it, and never above. It never falls back
    to the workspace's top.
  - Every resolver the build uses takes that root: `\input` and `\include`, `\includegraphics`, the
    bibliography (`.bib`, `.bbl`) and local `.sty`/`.cls` files. `..` above the root and a leading `/` are refused.
    So a paper's `\input{/private/notes}` can't pull the reader's own files into its PDF.
  - A document outside the copy that includes an imported file is the reader's own document: its normal root
    applies. The confinement protects the reader's files from the paper, not the other way round.
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
    when fetched", because the version isn't readable from the page (§1). The folder's notice always shows the
    fetch date.
  - Opening the link again opens the existing copy, with the reader's edits.
  - **Fetch again** never replaces anything. It imports into `/arXiv/<id> (fetched <date>)/` beside the old copy,
    and says whether the bytes changed (by SHA-256).
- **Trusted origin:** each entry the import makes carries an `origin: {arxiv: "<id>", sha256, fetched}` field in the
  workspace's own entry record, beside `made` (api.ts). It is set only by the arXiv import, inside the workspace, and
  no file contents can set it: an archive's own `.arxiv.json` or 00README is just a file. No file holds it, so
  deleting or editing a file in the folder doesn't remove it. Propagation:
  - **write** (an editor save, an agent's rewrite) keeps the entry, so it keeps its origin;
  - **rename, duplicate and move** carry it, as they carry `made`;
  - **create inside a folder that has an arXiv origin** gives the new entry the same origin. That covers what
    agents and the person make in the copy (notes, notebooks, generated files);
  - **text copied elsewhere** (pasted into another file, or written by an agent outside the copy) isn't tracked. No
    taint tracking of contents is attempted.
- **Threat model:** the policy keeps a reader from publishing a paper's source by accident, and keeps Sagebrush
  from storing or serving the fetched files. Sagebrush's upload boundaries check the origin:
  - sync;
  - share and publish;
  - the chat mirror's file attachments;
  - any server-side export.

  It does not stop a person, or an agent they direct, who copies the text into files outside the copy and shares
  those (nothing can without taint tracking). We say so in the folder notice.
- **Sync (needs a ruling, §8):** arXiv's terms forbid storing and serving source files from our servers, and they
  name no private-account exception. Workspace sync stores the person's files on Sagebrush's servers and serves
  them back to their own devices.
  - **Proposed for v1:** entries with an arXiv origin are local to the browser. Sync skips them, and the folder's
    notice says "This copy is only in this browser".
  - This needs a sync exclusion by entry origin, which the sync owner would add. Until it exists, the proxy ships
    behind the DEV flag.
  - With a permissive license (v2 metadata), sync could include them.
- **Public sharing respects the license, failing closed:**
  - a share, publish or export-to-share that includes any entry with an arXiv origin is refused unless that
    origin's license is permissive and recorded. In v1 the license is never recorded, so it is always refused: "This
    paper's source can't be shared publicly from Sagebrush." The message links to the abstract page, where the
    license is shown. A download to the person's own computer is still allowed: that's their copy, as from arXiv.
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
- **Attribution:** the folder's notice and the editor's header link to the abstract page ("from arXiv:<id>"), with
  no wording that implies arXiv endorses Sagebrush.

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
  - `\input{/x}`, `\input{../../x}`, a `.bib` and a `.sty` above the root are refused by the build, also after the
    copy folder is renamed and duplicated, after a single imported `.tex` is moved to another folder, after a
    nested subfolder is duplicated elsewhere, and after the import folder is deleted;
  - create inside the copy inherits the origin; write keeps it;
  - a truncated gzip, a corrupt trailer, concatenated members, a missing tar end marker, non-zero trailing data;
  - the import deadline and the idle deadline;
  - sync skips entries with an arXiv origin;
  - the Worker answers `/arxiv/*` without any outbound request.

## 8. Questions for a ruling

1. **Sync:** keep arXiv copies local to the browser in v1, as proposed in §5, given arXiv's "store and serve from
   your servers" rule? This needs a sync exclusion by origin, so the proxy stays behind the DEV flag until that
   lands. Or ask arXiv first?
2. **Sharing:** is v1 OK with no public sharing of arXiv copies at all, or do you want the v2 metadata endpoint
   (our only server-side arXiv request, paced worldwide) in v1?
3. **Unversioned links:** is "latest when fetched" in `/arXiv/<id>/` OK?
4. **Asking arXiv:** do we write to arXiv before launch (which host they prefer for per-reader `/src/` downloads,
   and the private-sync question)? Who writes?
5. **Caps** in §4: LIMITS to confirm.

Lanes for this note: SEC (the fetch, the extraction, path confinement, the build root, the origin and share check),
LIMITS (§4's caps, the pacing), COPY (the user-facing lines quoted above).
