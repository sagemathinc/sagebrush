# Test fixtures: two chapters of a Jupytext MyST book

`03-Number_Theory.md` and `09-Improving_DL.md` are chapters of *A Practical and Computational Introduction to
Mathematical Cryptography* © 2025 by Luís R. A. Finotti, github.com/lrfinotti/pcimc at 20bd4a76, licensed under
CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). They're unchanged, and used with the author's
permission to test Sagebrush's reader and renderer of Jupytext MyST notebooks (web/notebook/myst.js, web/myst).

`built-book.json` is what the book's own build (jupyter-book with sphinx-proof, luisfinotti.org/pcimc) shows for
these chapters: its boxes' titles, its equation numbers and its references' text, read from the pages named there
(each page's sha256 recorded), the oracle of test/myst-notebooks.test.ts's numbering checks.
