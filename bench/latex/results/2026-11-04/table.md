Times: min / median of 5 runs (one run of the oracle where corpus.json says so). TeX passes: latexmk's runs of the engine, cold / after the edit.

| document | latexmk cold | latexmk edit | TeX passes | CLI render | browser first preview | browser edit | cold: latexmk ÷ browser | edit: latexmk ÷ browser |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| C0 cjk | fails after 456 s: ! TeX capacity exceeded, sorry [main memory size=5000000]. | – | 1 / – | 1.12 s / 1.14 s | 1.99 s / 2.04 s | 497 ms / 552 ms | – | – |
| C0p cjk-paragraphs | 11 s / 11 s | 5.61 s / 5.64 s | 3 / 2 | 850 ms / 874 ms | 1.90 s / 1.91 s | 193 ms / 194 ms | 5.7× | 29× |
| C2 amsldoc | 1.78 s / 1.79 s | 653 ms / 657 ms | 4 / 1 | 660 ms / 669 ms | 530 ms / 538 ms | 73 ms / 74 ms | 3.3× | 8.9× |
| C3 beamer-talk | 6.19 s / 6.26 s | 3.87 s / 3.88 s | 2 / 1 | 470 ms / 476 ms | 310 ms / 317 ms | 26 ms / 32 ms | 20× | 120× |
| C1 arxiv-singular-moduli | 2.23 s / 2.24 s | 789 ms / 801 ms | 3 / 1 | 776 ms / 782 ms | 896 ms / 910 ms | 91 ms / 100 ms | 2.5× | 8.0× |
| C4 lshort | fails after 459 ms: ! Package babel Error: Unknown option 'francais'. Either you misspelled it | – | 1 / – | 864 ms / 868 ms | 668 ms / 671 ms | – | – | – |
| C5 sagetex-example | 856 ms / 864 ms | 468 ms / 471 ms | 2 / 1 | 465 ms / 467 ms | 281 ms / 288 ms | 21 ms / 24 ms | 3.0× | 19× |
| C5b pythontex-gallery | 2.04 s / 2.07 s | 2.03 s / 2.07 s | 1 / 1 | 467 ms / 471 ms | 294 ms / 307 ms | 29 ms / 38 ms | 6.8× | 54× |
| C6 pgfplots-2dplots | 22 s / 22 s | 21 s / 21 s | 3 / 3 | 4.39 s / 4.39 s | 3.20 s / 3.21 s | 255 ms / 258 ms | 6.7× | 83× |
| C7a example-article | 684 ms / 711 ms | 292 ms / 299 ms | 3 / 1 | 451 ms / 457 ms | 267 ms / 275 ms | 9 ms / 14 ms | 2.6× | 22× |
| C7b example-beamer | 1.78 s / 1.79 s | 934 ms / 938 ms | 2 / 1 | 420 ms / 426 ms | 242 ms / 251 ms | 8 ms / 13 ms | 7.1× | 72× |
| C7c example-sagetex | 339 ms / 341 ms | 316 ms / 318 ms | 1 / 1 | 413 ms / 416 ms | 229 ms / 238 ms | 11 ms / 14 ms | 1.4× | 23× |
| C7d example-pythontex | 1.73 s / 1.76 s | 1.71 s / 1.73 s | 1 / 1 | 404 ms / 406 ms | 232 ms / 243 ms | 9 ms / 13 ms | 7.2× | 130× |
| C7e example-matlab | 270 ms / 272 ms | 257 ms / 259 ms | 1 / 1 | 415 ms / 422 ms | 235 ms / 253 ms | 9 ms / 10 ms | 1.1× | 26× |
| C7f example-figure | 453 ms / 455 ms | 264 ms / 268 ms | 2 / 1 | 460 ms / 478 ms | 325 ms / 330 ms | 12 ms / 21 ms | 1.4× | 13× |
| C7g example-cv | 699 ms / 715 ms | 386 ms / 399 ms | 2 / 1 | 652 ms / 655 ms | 242 ms / 245 ms | 7 ms / 12 ms | 2.9× | 34× |
| C7h example-tikz | 644 ms / 648 ms | 627 ms / 634 ms | 1 / 1 | 405 ms / 409 ms | 233 ms / 245 ms | 8 ms / 10 ms | 2.6× | 66× |
| C7i example-bibliography | 365 ms / 370 ms | 223 ms / 223 ms | 2 / 1 | 391 ms / 395 ms | 231 ms / 234 ms | 10 ms / 19 ms | 1.6× | 12× |
| C7j example-homework | 251 ms / 255 ms | 242 ms / 243 ms | 1 / 1 | 409 ms / 417 ms | 239 ms / 243 ms | 10 ms / 17 ms | 1.1× | 14× |

- C5: the editor's Run 20 s / 20 s: "Ran 41 SageTeX items in 19.8 s; 15 failed"
- C7c: the editor's Run 2.27 s / 2.30 s: "Ran 8 SageTeX items in 2.3 s"
- C5, latexmk: no sage here: TeX only, the \sage results are ??
- C5b, latexmk: TeX errors: ! Package pdftex.def Error: File `myplot.pdf' not found: using draft setting.
- C7c, latexmk: no sage here: TeX only, the \sage results are ??
- C7d, latexmk: TeX errors: ! Undefined control sequence.
- C7e, latexmk: TeX errors: ! Misplaced alignment tab character &.

Fidelity: text recall / precision / Dice against the PDF's text (pdftotext); tokens PDF / preview; PDF pages; the preview's beamer frames and overlay steps; check's problems by kind.

| document | text R / P / Dice | tokens | PDF pages | preview frames | check problems |
|---|---:|---:|---:|---:|---|
| C0 cjk | – | – | – | – | none |
| C0p cjk-paragraphs | 0.999 / 1.000 / 1.000 | 600591 / 600000 | 591 | – | none |
| C2 amsldoc | 0.084 / 0.880 / 0.153 | 12057 / 1146 | 44 | – | command 496, environment 4, toolarge 1 |
| C3 beamer-talk | 0.597 / 0.897 / 0.717 | 1873 / 1248 | 31 | 22 frames, 27 steps | command 33, environment 10, not-rendered 8 |
| C1 arxiv-singular-moduli | 0.826 / 0.911 / 0.867 | 10660 / 9673 | 25 | – | math 2, toolarge 1 |
| C4 lshort | – | – | – | – | command 380, environment 120 |
| C5 sagetex-example | 0.987 / 0.733 / 0.841 | 1785 / 2404 | 8 | – | code 10 |
| C5b pythontex-gallery | 0.947 / 0.615 / 0.746 | 711 / 1094 | 3 | – | command 20, environment 9, image 1 |
| C6 pgfplots-2dplots | 0.027 / 0.701 / 0.051 | 15386 / 585 | 48 | – | command 125, input 2, expansion 1 |
| C7a example-article | 0.813 / 0.890 / 0.850 | 160 / 146 | 2 | – | none |
| C7b example-beamer | 0.536 / 1.000 / 0.698 | 140 / 75 | 7 | 5 frames, 7 steps | none |
| C7c example-sagetex | 0.963 / 0.811 / 0.880 | 80 / 95 | 1 | – | code 1 |
| C7d example-pythontex | 0.961 / 0.490 / 0.649 | 51 / 100 | 1 | – | none |
| C7e example-matlab | 0.960 / 0.933 / 0.946 | 101 / 104 | 1 | – | none |
| C7f example-figure | 0.907 / 0.907 / 0.907 | 54 / 54 | 1 | – | none |
| C7g example-cv | 1.000 / 1.000 / 1.000 | 74 / 74 | 1 | – | none |
| C7h example-tikz | 0.667 / 0.684 / 0.675 | 39 / 38 | 1 | – | not-rendered 2 |
| C7i example-bibliography | 0.989 / 1.000 / 0.994 | 90 / 89 | 1 | – | none |
| C7j example-homework | 0.941 / 0.980 / 0.960 | 51 / 49 | 1 | – | none |

- C0p: the PDF's tokens the preview lacks most: 1 (1), 2 (1), 3 (1), 4 (1), 5 (1), 6 (1), 7 (1), 8 (1), 9 (1), 10 (1), 11 (1), 12 (1)
- C2: the PDF's tokens the preview lacks most: the (550), of (217), to (200), and (177), in (168), 1 (163), is (162), 2 (146), for (135), 3 (121), 4 (112), equation (100)
- C3: the PDF's tokens the preview lacks most: news (50), results (50), 0 (44), the (41), hardness (35), introduction (27), bad (27), good (27), tractability (27), perfect (26), summary (25), 1 (23)
- C1: the PDF's tokens the preview lacks most: x1 (194), x2 (143), x3 (97), eπ (79), d1 (73), x4 (66), k1 (59), xk (55), xi (53), xj (49), of (32), di (32)
- C5: the PDF's tokens the preview lacks most: plotting (3), sagetex (2), 7 (2), paused (2), 6 (2), tik (2), 2026 (1), inline (1), eqn (1), 3d (1), make (1), include (1)
- C5b: the PDF's tokens the preview lacks most: pythontex (17), le (2), basic (2), gures (2), geo (1), rey (1), tex (1), general (1), pygments (1), de (1), ne (1), including (1)
- C6: the PDF's tokens the preview lacks most: 0 (709), the (537), 1 (510), 2 (407), to (243), axis (215), 3 (202), addplot (193), is (189), 4 (189), of (177), end (176)
- C7a: the PDF's tokens the preview lacks most: 1 (6), a2 (3), b2 (3), mod (3), introduction (2), statement (2), 3 (2), proof (2), 4 (2), c2 (1), d2 (1), x2 (1)
- C7b: the PDF's tokens the preview lacks most: 5 (8), short (7), talk (7), speaker (7), october (7), 2026 (7), 3 (3), the (2), overlays (2), first (2), question (2), slides (1)
- C7c: the PDF's tokens the preview lacks most: r1 (1), x3 (1), 2100 (1)
- C7d: the PDF's tokens the preview lacks most: pythontex (1), 103 (1)
- C7e: the PDF's tokens the preview lacks most: 10 (2), 12 (2)
- C7f: the PDF's tokens the preview lacks most: sin (2), cos (2), 1 (1)
- C7h: the PDF's tokens the preview lacks most: 1 (5), 5 (2), 0 (2), 2 (2), x2 (1), x3 (1)
- C7i: the PDF's tokens the preview lacks most: 1 (1)
- C7j: the PDF's tokens the preview lacks most: 1 (1), sin (1), dx (1)
