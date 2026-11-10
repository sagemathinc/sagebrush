<!-- description: Exactly what to expect from Sagebrush's LaTeX editor: a web page as you type, not a PDF; which commands, environments and packages it shows, what it shows instead for the rest, and how its output differs from pdflatex's. For people and for agents. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code and tests of the Sagebrush project, led by William Stein (SageMath, Inc.). Every row was checked with `sagebrush latex check` and `render` on November 10, 2026. -->
# How Sagebrush's LaTeX differs from LaTeX

Sagebrush's LaTeX editor shows your `.tex` as a **web page that updates
as you type**. It isn't TeX and it doesn't make a PDF. Part of LaTeX
is supported. This page lists what is, what isn't and what you see
instead, and where the output differs from `pdflatex`'s.

How it works inside, and how it is tested against TeX Live:
[How the LaTeX preview works](01-how-it-works.md).

## What you get

- A preview beside the source, updated as you type, in the browser. No
  TeX installation and no server.
- Beamer documents as slides, and **Present** to show them full screen,
  step by step.
- **Print / Save as PDF** from the preview: the browser's print dialog
  prints the rendered page. There is no TeX-to-PDF compiler.
- SageTeX and PythonTeX code run when you press **Run**: Sage code by
  Sagebrush's own Sage, Python code by its Python.
- The same preview on the command line, for agents:
  `sagebrush latex check`, `render` and `run` (see [For agents](#for-agents)).

## Supported

Supported means the preview shows it, not that it looks exactly as in
the PDF (see [Differences from pdflatex's output](#differences-from-pdflatexs-output)).

| area | what is shown | notes |
|---|---|---|
| Document classes | `article`, `report`, `book`, `amsart`, `memoir`, `beamer` and others | the class sets numbering depth; its page layout isn't used |
| Your own macros | `\newcommand`, `\renewcommand`, `\def`, `\newenvironment`, counters, conditionals | expanded as TeX does, with bounds on work, so a runaway macro stops |
| Several files | `\input`, `\include`, a `.sty` file beside the `.tex` | found from the document's folder as TeX finds them, `../` included, never above the workspace's top folder |
| Structure | `\part` to `\subparagraph`, `\maketitle`, `\tableofcontents`, `abstract`, `\appendix` | |
| Text | `\textbf`, `\textit`, `\emph`, `\texttt`, `\textsc`, `\underline`, sizes, `\footnote` (also `[n]`), `\marginpar`, `\verb`, `verbatim` | |
| Lists | `itemize`, `enumerate`, `description` | |
| Mathematics | `$…$`, `\[…\]`, `equation`, `align`, `gather`, `multline`, `split`, `aligned`, `cases`, matrices, `alignat`, `flalign`; in math `\tag`, `\intertext`, `\text`, `\boxed`, `\cancel`; `\DeclareMathOperator` | typeset by KaTeX |
| Theorems | `\newtheorem`, `\theoremstyle`, `proof` | |
| References | `\label`, `\ref`, `\eqref`, `\pageref`, `\nameref`, `\autoref`, `\cref`, `\Cref` | resolved at once, no second run |
| Floats | `figure`, `table`, `\caption`, `\includegraphics` | shown where they are written |
| Tables | `tabular`, `tabularx`, `longtable`, `array`, `\multicolumn`, `\hline`, `\cline`, `\toprule`, `\midrule`, `\bottomrule`, `\cmidrule` | |
| Links and color | `\url`, `\href`, `\hyperref`, `\textcolor`, `\color`, `\colorbox`, `\definecolor` | |
| Code | `lstlisting`, `minted`, `Verbatim`, `\lstinline` | shown as written, not highlighted |
| Citations | `\cite`, `\citet`, `\citep`, `thebibliography` with `\bibitem` | see BibTeX below |
| Beamer | frames, `block`, `columns`, overlays (`\pause`, `<2->`, `\only`, `\uncover`, `\alt`), each theme's headers and footers | the preview shows every overlay step at once; Present steps through them |
| SageTeX | `\sage`, `\sageplot`, `sageblock`, `sagesilent`, and `@interact` widgets | see [SageTeX](#sagetex-and-interact) |
| PythonTeX | `\py`, `pycode`, `pyblock`, `\printpythontex` | see [PythonTeX](#pythontex) |

## Not supported, and what you see instead

Apart from the two silent differences below, nothing is dropped without a mark. A command the preview doesn't know is
shown as a **grey chip** with its name, for example `\multirow`, and its
argument is shown as text after it. An environment it doesn't know is
shown as a **plain box** with its content. `sagebrush latex check` lists
each one with its line.

| what | what you see instead |
|---|---|
| `\multirow`, `\addlinespace`, `\footnotetext`, `\rotatebox`, `\resizebox`, `\scalebox`, `\reflectbox`, `\mintinline` | a grey chip, then the argument as text |
| siunitx: `\SI`, `\si`, `\num`, `\qty`, `\unit`, `\ang` | a grey chip, then the number or unit as written |
| biblatex: `\autocite`, `\textcite`, `\parencite`, `\footcite`; natbib: `\citeauthor`, `\citeyear` | a grey chip, then the key as text |
| babel and csquotes: `\selectlanguage`, `\foreignlanguage`, `otherlanguage`, `\enquote` | a grey chip or a plain box; the text itself is shown |
| `subfigure`, `subequations`, `algorithm`, `algorithmic`, `tcolorbox`, `mdframed`, `framed`, `landscape` | a plain box with the content |
| TikZ and pgfplots pictures: `tikzpicture` | a placeholder: the picture isn't drawn |
| BibTeX and biber: `\bibliography` with a `.bib` file | the line "[bibliography from refs.bib: BibTeX is not run]", and `\cite` shows the key in brackets, [knuth84] |
| PythonTeX's other commands and environments (pyc, pys, pyb, pyconsole, pysub, pyverbatim, and the families other than py) | the code as written, or a "not run" mark where its results would go |

A package named in `\usepackage` isn't loaded: its commands work only if
they are in the Supported table. A `.sty` file beside your `.tex` is the
exception: it is loaded and run as TeX.

Two silent differences are known: a `@{…}` column separator in a table
is dropped, and biblatex's `\printbibliography` shows nothing.

## Differences from pdflatex's output

| | the PDF | Sagebrush's preview |
|---|---|---|
| Pages | fixed pages, page breaks, headers and footers | one continuous web page; Beamer frames are slides |
| Fonts | Computer Modern, or the fonts the document loads | the browser's fonts for text; KaTeX's fonts for mathematics |
| Line breaks and spacing | TeX's paragraph breaking | the browser's |
| Floats | placed by TeX (`[t]`, `[h]`, ...) | where they are written |
| References | after a second run | at once |
| Bibliography | from BibTeX or biber | only `thebibliography` written in the document |
| Pictures | TikZ and pgfplots drawn | placeholders |
| Speed | about 0.5 to 20 s to remake the PDF after an edit | about 25 to 260 ms from a keystroke to the preview ([benchmark](01-how-it-works.md)) |

## SageTeX and @interact

- `\sage{…}`, `\sageplot{…}`, `sageblock` and `sagesilent` run when you
  press **Run** (or Shift+Enter, also while presenting): in document
  order, in one Sage session in the browser. Nothing runs without that.
- Results are kept beside the document, in `FILE.tex.results.json`. A
  result stays valid while its item and every item before it are
  unchanged. A changed item keeps its last value, shown faded, until
  you run again.
- Sage's `@interact` inside `sagesilent` or `sageblock` draws its
  controls. After a Run they are live, in the preview and in Present:
  change one and the function runs again. This is a Sagebrush extension:
  real LaTeX with SageTeX stops at it (`NameError: name 'interact' is
  not defined`).
- A plot wider than the slide's text stops at the text's edge here; in
  the PDF it runs past the margin.
- The code can read, but not change, the `.tex` itself and the files in
  the document's folder that the code names: the modules it imports
  (`from helper import f` gives it `helper.py`), the files whose paths it
  writes in quotes (`'data.csv'`), and the files those name in turn, up to
  500 files and 64 MB in all. Other files in the folder aren't given and
  don't count. A file reached only by a path built while the code runs,
  such as `open('data' + str(i) + '.csv')`, isn't given: Python reports it
  as not found.

## PythonTeX

- `\py{…}`, `pycode` and `pyblock` run when you press **Run**, with the
  SageTeX code, in document order. They run as plain Python, in a
  session of their own: Sage's names aren't in it.
- As in PythonTeX, their results are LaTeX. `\py`'s value and what
  `pycode` prints appear where the code stands; what a `pyblock` prints
  appears at the next `\printpythontex`. A `pyblock` also shows its code.
- Results are kept in the same results file, and stay valid and go stale
  as SageTeX's do. A stale result is shown faded; what it defines still
  holds, as in TeX.
- A result can't add code: code that comes only from a result (a `\py`
  or `pycode` it writes, a macro it defines, an `\input` it generates)
  isn't run, and says so. If a result changes which code runs at some
  place, the items there say so; press **Run** again to update.
- Inside `\py{…}` the preview supports plain Python expressions, without
  TeX commands.
- Code in `pycode` or `pyblock` that is indented as a whole (every line by
  the same amount) is dedented first and runs; real PythonTeX stops there
  with an IndentationError.

## For agents

- `npx sagebrush latex check FILE.tex` (`--json` for JSON) lists what the
  preview can't show or found wrong, each with its line: unsupported
  commands and environments, mathematics KaTeX can't typeset, missing
  images and files, code not run, expansion stopped. It exits 1 on an
  error.
- `npx sagebrush latex render FILE.tex --png DIR` writes one PNG per
  frame (per page for other documents); `--pdf OUT.pdf` prints the
  preview to a PDF.
- `npx sagebrush latex run FILE.tex` runs the SageTeX code and keeps the
  results.
- In the editor, the WebMCP tools `latex_check` and `latex_render` do
  the same.
- Write for what is supported above. Check after every change, and look
  at the PNGs.
