<!-- description: How Sagebrush previews LaTeX: a TeX-like macro expander and an HTML renderer with KaTeX in a Web Worker, Beamer slides and SageTeX; tested against TeX Live's latexmk on 19 public documents, with the speed, the fidelity, the gaps and what would have saved time. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code, tests, benchmark results and commit history of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
# How the LaTeX preview works

*Code: `web/latex/` (the editor, about 8,700 lines without its tests).
The expander is `web/latex/core/machine.mjs` and `engine/demo-machine.mjs`;
the renderer is `engine/render.mjs`; Beamer is `engine/beamer.mjs`;
SageTeX is `engine/sagetex.mjs` and `run-core.mjs`. The command line is
`src/latex-cli.ts`. The benchmark is `bench/latex/`.*

Open a `.tex` file in Sagebrush and the document appears beside its
source: headings, theorems, equations typeset by KaTeX, figures, tables,
footnotes, references, a bibliography. Type, and the preview follows. A
Beamer talk appears as slides. A SageTeX document's Sage code runs when
you press Run.

This is not TeX. TeX lays out pages and makes a PDF, and nothing here
replaces it. The preview reads the same source and shows what the PDF
will *say*: its text, its mathematics, its structure. It does so in the
browser, as you type, without installing TeX. Where it can't show
something, it says so.

## 1. An expander, then a renderer

LaTeX is a language of macros. `\section{Intro}` means something only
after the definitions it expands to, and a document can define its own.
So the preview has two parts.

**The expander** reads the source as TeX does: character codes,
category codes, control sequences, groups, registers and counters,
conditionals, `\def`, `\newcommand` and `\newenvironment`, with bounds on
work, depth and size, so a runaway macro stops instead of hanging the
page. It doesn't typeset. When it meets a command the preview knows
(a section, a figure, a reference, `\verb`, a Beamer frame), it records
an *event* in place of TeX's typesetting.

**The renderer** turns the events into HTML. Paragraphs become `<div>`s;
mathematics goes to KaTeX; theorems, lists, tables, floats, footnotes,
the table of contents, labels and references are laid out as a web page,
not as pages of a book.

Both run in a Web Worker, off the page's thread, so typing never waits
for them. The expander is **incremental**: it keeps checkpoints of its
state as it goes. After an edit it resumes from the last checkpoint
before the edit, and stops as soon as its state matches the previous run
again, reusing everything after that point. A one-character edit in the
middle of a 600-paragraph document re-expands in about 8 ms. The
renderer, today, renders the whole document again on each edit; that is
the next thing to make incremental (section 7).

**Several files.** `\input` and `\include` read the other files of the
document's folder, as TeX finds them. A change to one of them updates
the preview.

**Beamer.** A frame is a slide, at the class's aspect ratio. Overlays
(`\pause`, `<2->`, `\only`, `\uncover`, …) are all shown at once in the
preview, and Present steps through them full screen. The code for Beamer
is a separate file that only Beamer documents fetch; the editor itself
is fetched only when a `.tex` file is opened.

**SageTeX.** A document's `\sage{…}`, `sageblock` and `sagesilent` items
run when you press Run: in page order, in one session of Sagebrush's own
Sage, in the browser. Their results are kept beside the document
(`FILE.tex.results.json`). A result stays valid as long as its item and
every item before it are unchanged, so an edit near the end doesn't
re-run the beginning. Until you run again, a changed item keeps its last
value, shown faded. Nothing runs without a click, or Shift+Enter, which
also works while presenting. **PythonTeX is not run yet**: its code is
shown as written, with a "not run" mark where its results would go.

**Interactive widgets (Sagebrush only).** Sage's own `@interact` works
inside `sagesilent` and `sageblock`:

```latex
\begin{sagesilent}
@interact
def f(k=slider(1, 5, 1, 2)):
    show(plot(sin(k*x), (x, 0, pi)))
\end{sagesilent}
```

Run draws its controls where the block is, at their defaults, with what
the function prints and shows for them. After a Run, the controls are
live in the preview and in Present: change one and the function runs
again, replacing what it printed and showed, on the slide and in the
preview alike. In Present, a click or a key on a control is the
control's, not the next slide's; Escape still ends the presentation. Open the document again or another one, or
restart the interpreter, and they're drawn as they were until the next Run. A printed page or PDF shows the
same, marked "Interactive in Sagebrush". This is an extension:
real LaTeX with SageTeX and Sage 10.10 stop at it, because `interact`
isn't defined outside Sage's notebook interfaces (`NameError: name 'interact' is not
defined`). Keep it out of documents that must also build with `pdflatex`.

**For agents and the command line.** `sagebrush latex check FILE.tex`
lists what the preview can't show or found wrong, each with its line.
`sagebrush latex render` writes the preview as one self-contained HTML
file, or one PNG per slide. In the editor, an agent gets the same two
as tools, `latex_check` and `latex_render`.

## 2. Saying what it can't show

A preview that silently drops part of a document is worse than none: the
reader trusts it. So every gap is meant to be visible, in the preview
and in `check`. The kinds of problems it reports:

| kind | meaning |
|---|---|
| `command`, `environment` | not supported: shown as written, marked |
| `math` | KaTeX couldn't typeset a formula |
| `not-rendered` | a picture the preview doesn't draw (TikZ, pgfplots): a placeholder |
| `image`, `input` | a file not found, or outside the document's folder |
| `code` | SageTeX or PythonTeX code not run |
| `expansion` | the expander stopped at one of its bounds |
| `toolarge` | a block too large to show |

That goal is not met everywhere yet. Section 6 lists the places where
the preview was found to be silently wrong, and what is being done.

## 3. How it is tested: real TeX as the oracle

The question for each document is simple: what does TeX make of it? We
answer it with TeX itself.

`bench/latex/` (the harness) runs each document of a corpus in three
ways:
1. **TeX Live's `latexmk`**, cold in a fresh folder and again after a
   one-character edit;
2. **the command line**, `sagebrush latex render`;
3. **the editor** in a fresh headless Chrome, timed by the page's own
   marks: navigation to the first complete preview, and a typed
   character to its paint.

It then compares the PDF's words (`pdftotext`) with the preview's, as
multisets of words, and reports their recall, precision and Dice
similarity. Recall is how much of the PDF's text the preview has;
precision is how much of the preview's text the PDF has. Mathematics,
headers and pictures differ on both sides, so 1.0 isn't expected. A low
number is the signal, and the words missing most say why.

**The corpus** is public, with its licenses: an arXiv paper (CC BY 4.0);
the amsmath user's guide (LPPL); Beamer's conference-talk example
(LPPL); *The Not So Short Introduction to LaTeX* (GPL); SageTeX's and
PythonTeX's own examples (GPL, LPPL); a chapter of the pgfplots manual
(GPL); a generated document of Chinese text; and the ten examples that
ship with Sagebrush. `bench/latex/LICENSES.md` gives each source,
pinned to a commit and a checksum.

Besides the benchmark there are two more kinds of tests. A **fidelity
campaign** writes small documents, compiles each with TeX Live, and
compares. Its first digest (48 documents, all compiling) reduced 13 of
them to one-line examples of five families of silent errors. Every fix
in the preview also comes with **unit tests that are mutation-tested**:
each guard in the new code is removed in turn, and some test must fail
without it.

## 4. Speed

The benchmark of November 4, 2026 ran on a 16-core virtual machine (AMD
EPYC 7B13), quiet before every run, with TeX Live 2023 and Chrome 155.
Times are **medians of 5 runs**.

**Time to the first preview**, against `latexmk` making the PDF from
nothing:

| document | `latexmk`, cold | preview, first | faster |
|---|---:|---:|---:|
| C3 Beamer talk | 6.26 s | 317 ms | 20× |
| C6 pgfplots manual, 2-D plots (48 pages) | 22 s | 3.21 s | 6.7× |
| C0p 1,500 paragraphs of Chinese | 11 s | 1.91 s | 5.7× |
| C5b PythonTeX gallery | 2.07 s | 307 ms | 6.8× |
| C2 amsmath user's guide | 1.79 s | 538 ms | 3.3× |
| C5 SageTeX example | 864 ms | 288 ms | 3.0× |
| C1 arXiv paper, 25 pages | 2.24 s | 910 ms | 2.5× |
| C7 our ten examples | 255 ms – 1.79 s | 234 – 330 ms | 1.1 – 7.2× |
| C0 the same Chinese text as one paragraph | **fails** after 456 s (TeX capacity exceeded) | 2.04 s | – |

**Time from a typed character to the preview** showing it, against
`latexmk` remaking the PDF after the same edit:

| document | `latexmk`, after the edit | preview | faster |
|---|---:|---:|---:|
| C3 Beamer talk | 3.88 s | 32 ms | 120× |
| C6 pgfplots manual | 21 s | 258 ms | 83× |
| C5b PythonTeX gallery | 2.07 s | 38 ms | 54× |
| C0p Chinese text | 5.64 s | 194 ms | 29× |
| C5 SageTeX example | 471 ms | 24 ms | 19× |
| C2 amsmath user's guide | 657 ms | 74 ms | 8.9× |
| C1 arXiv paper | 801 ms | 100 ms | 8.0× |
| C7 our ten examples | 223 ms – 1.73 s | 10 – 21 ms | 12 – 130× |

For SageTeX and PythonTeX, `latexmk` ran TeX only here (no Sage was
installed), so their TeX times leave out the code's own run. The
preview's Run of the SageTeX example's 41 items took 19.9 s in Sagebrush.

The first measurements of C6 were wrong, and worth telling. A document
with `\input` is painted first with its included files not yet read,
then again once they are. The harness took that first paint as "the
preview" and reported 240 ms. The complete preview takes 3.21 s, which
is the number above.

## 5. Fidelity

Text similarity (Dice) between the preview and TeX's PDF, at the
benchmark, with the main reason for each lower number:

| document | Dice | what is missing |
|---|---:|---|
| C0p Chinese text | 1.000 | – |
| C7 our ten examples | 0.649 – 1.000 | PythonTeX's results; two TikZ labels |
| C1 arXiv paper | 0.867 | mostly mathematics written differently |
| C5 SageTeX example | 0.841 | |
| C5b PythonTeX gallery | 0.746 | PythonTeX isn't run: code where the PDF has results |
| C3 Beamer talk | 0.717 | the theme's headers and footers on every slide |
| C7b Beamer example | 0.698 (recall 0.536) | the same |
| C2 amsmath user's guide | 0.153 | a bug, since fixed: 0.851 |
| C6 pgfplots manual | 0.051 (recall 0.027) | the plots, and the manual's own macros |

**The gaps, plainly:**
- **Beamer's headers and footers.** A Beamer theme repeats the title,
  author, date, section names and slide number on every slide; the
  preview showed none of it, so about half the words of a Beamer PDF
  were missing. Each theme's headers and footers are now drawn as TeX
  Live's Beamer draws them, checked word for word against TeX on 27
  themes. With them, C3 rises to 0.828 and the example to 0.880. That
  change is in review.
- **TikZ and pgfplots** aren't drawn: a picture is a placeholder, and
  `check` says so. The pgfplots manual's chapter also stops early, at one
  of the expander's bounds, inside the manual's own macro machinery.
- ***The Not So Short Introduction to LaTeX*** uses many packages the
  preview doesn't know: `check` reports 380 commands and 120
  environments it can't show. And here the oracle failed too: TeX Live
  2023's babel rejects the book's `francais` option, so there was no PDF
  to compare with.
- **The amsmath guide** writes code between bars, `|\begin{aligned}|`, as
  short verbatim. The preview read the `\begin{aligned}` as real, and the
  rest of the document disappeared into one block: 8% of the words.
  Found by the benchmark, fixed, now 0.851.

## 6. What's next

**The silent errors.** The fidelity campaign found five families of
places where the preview was wrong and said nothing:
- **counters:** `\setcounter` and `\footnote[7]` ignored;
- **references:** `\nameref` gave a number, `\cref{a,b}` gave `??`, and
  so did a `\label` after `\section*`;
- **saved boxes:** `\sbox` and `\usebox` dropped their text;
- **tables:** `@{…}` column separators dropped;
- **contents:** short titles and `\addcontentsline` ignored.

Silent wrong output is worse than a visible gap, so these come first.
Fixes for the first three match TeX on the campaign's examples, and on
29 references checked against cleveref, and are in review. Tables and
contents come next.

**Then:** PythonTeX run as SageTeX is; large tables; and an incremental
renderer. After an edit, re-rendering is now 87 to 96% of the time on
large documents (about 200 ms of 208 ms on the Chinese text), so that is
where the edit time goes.

## What would have saved time

- **Real TeX as the oracle from the first day.** One benchmark run found
  a bug that hid 92% of the amsmath guide, and the cause of the Beamer
  gap, both invisible to unit tests written by the same hands as the
  code.
- **Measure what the reader sees.** The first benchmark timed a partial
  paint as the preview and made a 3-second preview look like 240 ms. Wait
  for the state a person would call "done", and say what it is.
- **Ask TeX instead of guessing.** cleveref sorts its references, writes
  "eq. (1)", and runs three into "1 to 3"; Beamer lists starred sections
  in its navigation; `\documentclass{ beamer }` fails. Each was a
  one-minute question to TeX, and a wrong guess each time it wasn't
  asked.
- **Report what you can't show, from the start.** The costliest errors
  were the silent ones; every visible gap was cheap.
