<!-- description: How Sagebrush shows a LaTeX document as you type it: its own TeX-like expander and an HTML renderer with KaTeX, in the browser, checked against real TeX Live on public documents. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code, tests, benchmark results and commit history of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
# LaTeX

Sagebrush shows a LaTeX document as you type it. Open a `.tex` file and
its preview appears beside the source, in the browser, with no TeX
installation and no server. Edit a character and the preview follows,
usually within a frame or two. Beamer talks are shown as slides and can
be presented. SageTeX code runs in Sagebrush's own Sage. The same preview
is on the command line, as `sagebrush latex`, for people and for agents.

It is a live preview, not a replacement for TeX. TeX makes the PDF. The
preview is built to show you, fast, what the PDF will say, and to say
plainly what it can't show. We measured both, against real TeX Live, on
public documents.

**[Open this article as a LaTeX document in the editor](/?tex-doc=/articles/latex/how-it-works.tex)**
and **[as a Beamer talk](/?tex-doc=/articles/latex/how-it-works-talk.tex)**
(press Present for its slides). Each opens read only: its source beside
the preview Sagebrush makes of it. "Edit a copy" gives you your own copy
to change, and the preview follows as you type. It works on a phone too.
The two sources are here too, as plain files:
[how-it-works.tex](how-it-works.tex) and
[how-it-works-talk.tex](how-it-works-talk.tex).

1. [How the LaTeX preview works](01-how-it-works.md): the expander, the
   renderer, Beamer and SageTeX; how it is tested against TeX Live; the
   numbers, speed and fidelity, from the benchmark of November 4, 2026;
   the gaps, and what would have saved time.
2. [How Sagebrush's LaTeX differs from LaTeX](02-how-it-differs.md):
   exactly what to expect: a web page as you type, not a PDF; what is
   supported, what isn't and what you see instead; the differences from
   pdflatex's output; SageTeX and `@interact`; for agents.
