# Real LaTeX against Sagebrush's LaTeX preview

## In plain words

Sagebrush's LaTeX editor doesn't run TeX. It reads the `.tex` source itself and
shows a preview in the browser, as the notebook kernels approximate Sage or
MATLAB instead of running them. This benchmark checks that approach against
real TeX (TeX Live's `latexmk`) on the same documents, and asks two questions:

- **How fast is it?** The time to see a document the first time, and the time
  to see the change after typing one character. TeX's times are latexmk's in a
  fresh folder (cold, every pass it needs), then after the same one-character
  edit.
- **How much of the document does it show?** The preview's words against the
  PDF's words; beamer frames and overlay steps against PDF pages; and what the
  preview reports it can't show.

It is run by hand, or nightly, on a quiet machine. It is not part of a PR's CI.
Results with a date are in `results/`.

## What it measures

`run.mjs` runs each document of `corpus.json` several times (`--runs`, 5 by
default) in three ways, waiting before each run until the 1-minute load is
under 1 (`--max-load`):

- **oracle:** `latexmk -pdf` (or `-xelatex`) in a fresh temporary folder: cold
  (no `.aux`, so latexmk runs as many passes as the document needs; it counts
  them), then after the edit (an `x` inserted after the first occurrence of
  the document's `edit.after` text).
- **cli:** `sagebrush latex render FILE.tex`, the preview as one HTML file
  (`node build/cli/pyjs.cjs latex render`). This includes node's start and
  loading the bundle.
- **browser:** the editor page from `web/dist`, in a new headless Chrome for
  each run (a fresh profile, HTTP cache off). The file is made in that
  profile's workspace, then the editor is opened on it by URL. Times come
  from the page's own marks (`web/latex/editor.ts`):
  - *first preview* runs from the navigation's start to the first
    `tex-paint` (the whole preview patched in and a frame painted) with
    every `\input` read. A document with `\input` is painted first with
    each included file "not read yet", then again once the page has read
    them (a round for each level of nesting); the first of those paints is
    `partial_ms` in `results.json`;
  - *edit* runs from a typed character's `tex-input` to the `tex-paint` of
    its revision. The character is `Input.insertText` at the anchor.

From each document's first run it keeps the PDF, the preview's text and
`sagebrush latex check --json`, and `fidelity.mjs` compares them:

- **text:** the PDF's words (`pdftotext`) against the preview's, as multisets
  of tokens (words of letters or digits; each CJK character a token). It
  reports recall (how many of the PDF's tokens the preview has), precision
  (how many of the preview's the PDF has) and their Dice similarity, plus the
  PDF tokens the preview lacks most.
  - Math, page furniture (headers, beamer's navigation bar) and TikZ labels
    differ on both sides, so 1.0 isn't expected. A low number is the signal,
    and the missing words say why.
- **structure:** PDF pages; for beamer, the preview's frames and overlay
  steps (each step is a PDF page).
- **unsupported:** check's problems, counted by kind.

## Running it

It needs TeX Live with latexmk (and xelatex for the CJK rows), poppler-utils
(`pdfinfo`, `pdftotext`), Chrome or Chromium, Python 3, and the two builds:

```sh
node scripts/build-cli.mjs                     # build/cli: the CLI and sagebrush-latex.cjs
pnpm build                                     # dist/src, which web/build.ts needs
SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts  # web/dist, the editor also on 127.0.0.1
CHROME=google-chrome node bench/latex/run.mjs --runs 5 [--docs C0,C2] [--parts oracle,cli,browser]
node bench/latex/fidelity.mjs bench/latex/results/<date>   # the fidelity table again
```

It prints a Markdown table and writes `results/<date>/`: `results.json` (every
run, the load before it, and the versions), `table.md`, and the per-document
files that fidelity uses (not tracked). It downloads the documents into
`corpus-cache/` (not tracked) and checks each against its sha256 in
`corpus.json`. `LICENSES.md` gives each document's license.

Other settings:

- `CLI=`, `WEB_DIST=`: other builds (`WEB_DIST` a `web/dist`, served by the
  `web/serve.py` beside it).
- `SAGEBRUSH_REV=`: the commit the builds are of, when they were copied to a
  machine without the repository.
- `BENCH_VERBOSE=1`: each browser step, timed.
- `BENCH_PAINT_MS=`: how long to wait for a first preview (default 300 s).

## The documents

| id | document | why |
|---|---|---|
| C0 | 1500 lines of CJK text in one paragraph (1.95 MB) | the editor's large non-ASCII case (`web/latex/test-latex-page.mjs`) |
| C0p | the same lines as 1500 paragraphs | the form TeX can typeset (C0 is one paragraph, and TeX runs out of memory on it) |
| C1 | a 25-page arXiv paper (amsart, CC BY 4.0) | a typical research paper |
| C2 | `amsldoc.tex`, the amsmath user's guide | a long, math-heavy manual with its own class |
| C3 | beamer's conference-talk example | a beamer talk: themes, overlays, TikZ |
| C4 | *The Not So Short Introduction to LaTeX* (v5.0.6) | a book of `\include`'d chapters |
| C5 | SageTeX's `example.tex` | SageTeX; the browser also times Run |
| C5b | PythonTeX's gallery | PythonTeX |
| C6 | the pgfplots manual's chapter on 2D plots | TikZ and pgfplots, heavy |
| C7a–j | our ten examples (`web/latex/examples.ts`) | the baseline: what we show people first |

Some documents need more than plain `latexmk` (`corpus.json` says how each one runs):

- **C3:** its source is latin1. The editor opens only UTF-8 (`web/latex/save.ts`), so every part runs on it converted to UTF-8, its `inputenc` option included.
- **C4:** today's babel raises errors on it, so latexmk runs with `-f` (the errors are recorded). Its current master needs LuaLaTeX, biber and minted's executable. The edit is in a chapter file, so the browser doesn't time an edit there.
- **C5, C7c:** `sagetex.sty` is made from sagetex's own `.ins` (untimed). Where `sage` is installed, the oracle runs latex, sage and latex, timed as one compile; without it, TeX only, and the results show as `??`.
- **C5b, C7d:** latex, pythontex and latex, timed as one compile.
- **C6:** the manual's own preamble (with its clickable library off), the repository's pgfplots (`TEXINPUTS`), and its externalized figures (`-shell-escape`), as the manual is built. The browser gets the files of the manual's folder.

A corpus entry's forms (`run.mjs`, `source()`):

- `url` (one file), `files` (several, each pinned), `archive` (a `.tar.gz`), `example`, `gen`;
- `write` and `wrap` (files made in the folder);
- `prepare` (commands run once, untimed);
- `oracle` (`args`, `env`, `cycle`);
- `edit` (`after`, and `file` when the edit is not in the main file);
- `run` (time the editor's Run).
