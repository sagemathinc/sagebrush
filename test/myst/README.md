# Test fixtures: five chapters of a Jupytext MyST book, and its table of contents

`00-Intro.md`, `03-Number_Theory.md`, `07-Computing_DL.md`, `08-CRT_Bezout.md`, `09-Improving_DL.md` and `_toc.yml`
are from *A Practical and Computational Introduction to Mathematical Cryptography* © 2025 by Luís R. A. Finotti,
github.com/lrfinotti/pcimc at 20bd4a76, licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/).
They're unchanged, and used with the author's permission to test Sagebrush's reader and renderer of Jupytext MyST
notebooks (web/notebook/myst.js, web/myst) and its reading of a book (web/myst/book.ts).  The other chapters the
table of contents lists aren't here, which the tests use too: a listed chapter that's missing keeps its number.

`built-book.json` is what the book's own build (jupyter-book with sphinx-proof, luisfinotti.org/pcimc) shows for
chapters 3 and 9: its boxes' titles, its equation numbers and its references' text, read from the pages named there
(each page's sha256 recorded), the oracle of test/myst-notebooks.test.ts's numbering checks.  `built-book-p2.json`
is the same for the five chapters here, with each reference's target page, fetched (with the date) and read by a
script (the P2 packet's oracle.py), the oracle of test/myst-book.test.ts's cross-chapter checks.
