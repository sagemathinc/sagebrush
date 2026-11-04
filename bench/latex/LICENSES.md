# The benchmark's documents and their licenses

None of these files is in this repository. `run.mjs` fetches each from the
commit-pinned URLs in `corpus.json` into `corpus-cache/` (not tracked) and
checks its sha256, or generates it, or takes it from `web/latex/examples.ts`.

| id | document | source | license |
|---|---|---|---|
| C0, C0p | CJK text, generated | `run.mjs` (`GEN`), the fixture of `web/latex/test-latex-page.mjs` | this repository's (MIT / Apache-2.0) |
| C1 | G. Fowler and E. Tron, *Distinct differences of singular moduli* | [arXiv:2503.19686v2](https://arxiv.org/abs/2503.19686v2), its source (`e-print`) | CC BY 4.0 (arXiv's license field) |
| C2 | `amsldoc.tex`, the amsmath user's guide | [latex3/latex2e @ db6df638](https://github.com/latex3/latex2e/blob/db6df6380f8660758d26b9666d0e70600a3d7be9/required/amsmath/amsldoc.tex) | LPPL 1.3c ([required/amsmath/README.md](https://github.com/latex3/latex2e/blob/db6df6380f8660758d26b9666d0e70600a3d7be9/required/amsmath/README.md)) |
| C3 | `beamerexample-conference-talk.tex` | [josephwright/beamer @ e9e99b8f](https://github.com/josephwright/beamer/blob/e9e99b8fdc3084d9f118a761264be37184899e4b/doc/examples/a-conference-talk/beamerexample-conference-talk.tex) | LPPL 1.3c, or GFDL 1.3 or later (a file under doc/, beamer's documentation: [LICENSE.md](https://github.com/josephwright/beamer/blob/e9e99b8fdc3084d9f118a761264be37184899e4b/LICENSE.md); its own header says LPPL and/or GPL) |
| C4 | *The Not So Short Introduction to LaTeX*, v5.0.6 | [oetiker/lshort tag v5.0.6 (0008af1a)](https://github.com/oetiker/lshort/tree/0008af1aebd8662ab726acc753ffc770e8665c12/book/src), `book/src` | GPL 2 or later (its `contrib.tex`) |
| C5 | SageTeX's `example.tex`, and `sagetex.ins` / `.dtx` (to make `sagetex.sty`) | [sagemath/sagetex @ f9f1ba62](https://github.com/sagemath/sagetex/tree/f9f1ba62c9aa5b3a22f7ac2b5c583df749594cd3) | GPL 2 or later ([LICENSE](https://github.com/sagemath/sagetex/blob/f9f1ba62c9aa5b3a22f7ac2b5c583df749594cd3/LICENSE)) |
| C5b | `pythontex_gallery.tex` | [gpoore/pythontex @ 78c98144](https://github.com/gpoore/pythontex/blob/78c98144145150b6884e3e68159fa8b95bc53c1d/pythontex_gallery/pythontex_gallery.tex) | LPPL (LaTeX code; [README.rst](https://github.com/gpoore/pythontex/blob/78c98144145150b6884e3e68159fa8b95bc53c1d/README.rst)) |
| C6 | the pgfplots manual: its preamble and the chapter on 2D plots, with the repository's pgfplots | [pgf-tikz/pgfplots @ 80c5c7cf](https://github.com/pgf-tikz/pgfplots/tree/80c5c7cf40257258bd03c69a77cd46adbf05e028) (GitHub's archive of the commit) | GPL 3 or later (the repository's [README.md](https://github.com/pgf-tikz/pgfplots/blob/80c5c7cf40257258bd03c69a77cd46adbf05e028/README.md)) |
| C7a–C7j | our ten examples | `web/latex/examples.ts` | this repository's (MIT / Apache-2.0) |
