---
jupytext:
  formats: ipynb,sage:percent,md:myst
  encoding: '# -*- coding: utf-8 -*-'
  text_representation:
    extension: .md
    format_name: myst
    format_version: 0.13
    jupytext_version: 1.18.1
kernelspec:
  display_name: SageMath 10.7
  language: sage
  name: sage-10.7
---

# About this Book

+++

## Table of Contents

```{tableofcontents}
```

+++

## Introduction

This book is an introduction to the main mathematical and computational ideas in cryptography.  It is heavily based on selected sections of [An Introduction to Mathematical Cryptography](https://link.springer.com/chapter/10.1007/978-1-4939-1711-2_7), by Jeffrey Hoffstein, Jill Pipher, and Joseph H. Silverman, which is an excellent introduction to mathematical cryptography.  In fact, we strongly recommend the more mathematically inclined readers to use that book in addition to (or perhaps even instead of) this present one.  This book does not go nearly as deep in the math, but focus more in computations and applications.  For example, we might just give computational evidence that some mathematical statement is true, rather than giving an actual proof.  We do prove the easier statements, though, and although these could be skipped by the reader with less interest in the mathematics, we urge them to at least try read them, even if only superficially enough to have a general idea of why the statement is true.

For the last chapter on the [Advanced Encryption Standard](https://en.wikipedia.org/wiki/Advanced_Encryption_Standard), which is not covered in the previous reference, our main source was Trappe and Washington's [Introduction to Cryptography and Coding Theory](https://www.pearson.com/en-us/subject-catalog/p/introduction-to-cryptography-with-coding-theory/P200000006384/9780135260166), another excellent book.

This book was written to serve as a text book for [CYBR 201 - Introduction to Cryptography and Data Protection](https://catalog.utk.edu/content.php?filter%5B27%5D=CYBR&filter%5B29%5D=201&filter%5Bkeyword%5D=&filter%5B32%5D=1&filter%5Bcpage%5D=1&cur_cat_oid=54&expand=&navoid=11523&search_database=Filter#) at the [University of Tennessee](https://www.utk.edu/), which the author proposed and developed.

+++

## Goal

The main goal of this book is to introduce the mathematical ideas behind [cryptosystems](https://en.wikipedia.org/wiki/Cryptosystem) and [digital signature](https://en.wikipedia.org/wiki/Digital_signature) methods, but with a very practical and computational approach and with minimal prerequisites in mathematics.  By following this book, the reader should be able to understand the underlying mathematical problems on which the security of cryptosystems and digital signatures are based, and the computational challenges associated to them.

We hope that by following this book, the more mathematically inclined, but with less experience with coding, should realize the difficulties of finding efficient methods for computations of even the most basic mathematical objects.  Finding these methods requires a shift on how we think about mathematical problems.

On the other hand, the more computationally inclined readers, but with less mathematical background, should realize that mathematical insights quite often yield much greater gains than any clever coding.

Those who are just starting with both the math and programming at this level will hopefully appreciate the important relation between the two approaches in a very practical and concrete setting.

This way, we hope that all these groups should benefit from this book.

+++

## Topics

The main goal it to cover the following applications:

1) [Diffie-Hellman Key Exchange](#DH_key_exchange),
2) the [ElGamal Cryptosystem](#sec-elgamal),
3) the [RSA Cryptosystem](#sec-rsa),
4) the [RSA](#sec-rsa-ds), [ElGamal](#sec-elgamal-ds), [DSA](#sec-dsa) digital signatures,
5) [elliptic curve](#sec-ec) [cryptography](#sec-ec_crypto) and [digital signature](#sec-ec_DSA),
6) and the [Advanced Encryption Standard (AES)](#sec-aes).

We will also discuss the main methods of attack to these, by discussing efficient methods for factorization and computing [discrete logs](#sec-dl), such as:

1) [Collision (Shank's  Baby-Step/Giant-Step Algorithm)](#sec-bsgs) (for computing discrete logs),
2) the [Pohlig-Hellman Algorithm](#sec-pohlig-hellman) (for computing discrete logs),
3) [Index Calculus](#sec-index-calc) (for computing discrete logs in $\mathbb{F}_p^{\times}$),
4) [Pollard's $p-1$ factorization algorithm](#sec-pollards_p-1),
5) [Factorization via Difference of Squares](#sec-diff-squares),
6) the [Quadratic Sieve](#sec-quad_sieve).

To properly cover this topics, we need to cover some basic [Number Theory](#ch-number_theory), including:

1) [Long Division](#sec-long_div),
2) [Prime Numbers](#sec-primes),
3) [Greatest Common Divisor](#sec-gcd), including the {prf:ref}`Euclidean Algorithm <alg-ea>` and {prf:ref}`Extended Euclidean Algorithm <al-eea>`,
4) {prf:ref}`Fundamental Theorem of Arithmetic <th-fta>`,
5) [Congruences](#sec-congruences),
6) [Integers Modulo $m$](#sec-int_mod_m) and its [units](#sec-units_zm),
7) {prf:ref}`Euler's Theorem <th-euler>` and {prf:ref}`Fermat's Little Theorem <th-flt>`,
8) the [Chinese Remainder Theorem](#sec-crt),
9) [Primality Testing](#ch-primality) (including the {prf:ref}`Miller-Rabin Probabilistic Test <al-mr>`),
10) [Quadratic Reciprocity](#sec-quad_rec),
11) [Square Roots Modulo $m$](#ch-sqrt_zm),
12) [Elliptic Curves](#sec-ec),
13) [Finite Fields](#sec-finite-fields),
14) and related computational problems.

We will also have a very practical approach when covering this theory.  Although we will provide proofs to the simpler results, we often will just demonstrate statements with some concrete computations.  Concrete examples will also be provided to illustrate the statements.  Moreover, the computations will always be done with the help of [Sage](https://www.sagemath.org/).  Hence, although our goal is to illustrate the importance of mathematics in cryptography, we do not require any higher-level background in mathematics.

We will also give a brief introduction to the basic tools of Python and Sage necessary for the course.

+++

## Computations

There is a large focus on computations, since the challenges involved in creating and breaking cryptosystems are computational in nature.  Therefore we will focus on computational methods in [Number Theory](https://en.wikipedia.org/wiki/Number_theory), the main mathematical background for the cryptosystems introduced here.  We will discuss many methods and algorithms, but always with a practical goal.

We will not assume any previous background in Number Theory, but we will introduce the needed results as we progress.

+++

## Sage

We will use [Sage](https://www.sagemath.org/) as the main programming language for our examples.  Sage is based on [Python](https://www.python.org/), which is a simple and yet powerful programming language, often taught as a first programming language.  Sage uses the same syntax as Python, so it should be easy for those who already know Python to use Sage, while been a suitable introduction to programming as well.

Sage adds a lot more mathematical functionality to Python out of the box, making the implementation and testing of the methods in this book a lot easier, when compared to plain Python.

As with Python, Sage if free and open source.  It can be installed directly in the users computer or used online with [Cocalc](https://cocalc.com/).

We will not assume that the reader has any previous experience with coding, and introduce the necessary background in the text.  But experience with coding, especially in Python,  would certainly benefit the reader.

+++

## Homework

We suggest the reader complete the corresponding [homework assignments](#hw).  These implement methods and algorithms described in the text, and therefore are computational (rather than purely mathematical) in nature.  The goal is to reinforce the ideas introduced and allow the reader to experience the difficulties and efficiency differences between different methods.

These are available as [Jupyter Notebooks](https://jupyter.org/) that should be run using Sage as the kernel.  *These notebooks will not work with pure Python!*

Most routines that the reader will implement are available in Sage already, and in fact these will be used to test the reader's code in the homework.  But, again, the goal is not to have the final product/tool, it is to *understand* how these methods work, what they involve, what is the math behind it, and to see in them working in practice.

Hopefully the homework give the reader practice with coding, with a particular care about efficiency.

+++

## Source Notebooks

The source Jupyter notebooks from each chapter used to create this book can be downloaded directly from the official site https://luisfinotti.org/pcimc/.  Just click on the Download icon on the top of the page and choose `.ipynb`.

**Important:** To be able to run this properly, a [Sage](https://www.sagemath.org/) kernel *must* be used.  And, for the notebook to be displayed correctly, the [JupyterLab MyST Extension](https://github.com/jupyter-book/jupyterlab-myst) must be installed in the system.

Unfortunately, the links to different notebooks will not work.

+++

## Corrections

Please send any typos, corrections (mathematical or grammatical), problems, and suggestions to luis@luisfinotti.org.

+++ {"jp-MarkdownHeadingCollapsed": true}

## About the Author

[Luís Finotti](https://luisfinotti.org/) received his B.Sci. and M.Sci. in Mathematics from the [Universidade de São Paulo](https://www.usp.br/) in Brazil, and his Ph.D. in 2001 from the [University of Texas at Austin](https://www.utexas.edu/), studying with [Felipe Voloch](https://www.math.canterbury.ac.nz/~f.voloch/) and specializing in [Number Theory](https://en.wikipedia.org/wiki/Number_theory).

He had post-doctoral appointments at the [University of California Santa Barbara](https://www.ucsb.edu/) and the [Ohio State University](https://www.osu.edu/).  He has been at the [University of Tennesse Knoxville](https://www.utk.edu/) since 2006.

His research interests include liftings of [algebraic curves](https://en.wikipedia.org/wiki/Algebraic_curve) and [varieties](https://en.wikipedia.org/wiki/Algebraic_variety), specially [elliptic](https://en.wikipedia.org/wiki/Elliptic_curve) and [hyperelliptic](https://en.wikipedia.org/wiki/Hyperelliptic_curve) curves, [Witt vectors](https://en.wikipedia.org/wiki/Witt_vector), [local](https://en.wikipedia.org/wiki/Local_field) and [$p$-adic](https://en.wikipedia.org/wiki/P-adic_number) fields, and related computational problems and applications.

+++

## Acknowledgments

The book [An Introduction to Mathematical Cryptography](https://link.springer.com/chapter/10.1007/978-1-4939-1711-2_7), by Jeffrey Hoffstein, Jill Pipher, and Joseph H. Silverman, was the main resource for this book, along with class notes from the author on a course based in that book.  The book [Introduction to Cryptography and Coding Theory](https://www.pearson.com/en-us/subject-catalog/p/introduction-to-cryptography-with-coding-theory/P200000006384/9780135260166) by Wade Trappe and Lawrence C. Washington was the main source for the last chapter.

This book was produced using [Jupyter notebooks](https://jupyter.org/) and [Jupyter Book](https://jupyterbook.org/en/stable/intro.html).  [MyST Markdown](https://mystmd.org/) (and [LaTeX](https://www.latex-project.org/)) were used to type and render the text.  The computations were done with [Sage](https://www.sagemath.org/).

This book was written during a semester in which the [College of Emerging and Collaborative Studies](https://cecs.utk.edu/) at the [University of Tennessee](https://www.utk.edu/) reduced the author's teaching load, allowing the writing of this book.  The teaching reduction was given so the author could develop the new course [CYBR 201 - Introduction to Cryptography and Data Protection](https://catalog.utk.edu/content.php?filter%5B27%5D=CYBR&filter%5B29%5D=201&filter%5Bkeyword%5D=&filter%5B32%5D=1&filter%5Bcpage%5D=1&cur_cat_oid=54&expand=&navoid=11523&search_database=Filter#), and although writing the book was not a requirement, the extra time allowed the author to do it.  Therefore, the author would like to thank the [University of Tennessee](https://www.utk.edu/), the [College of Emerging and Collaborative Studies](https://cecs.utk.edu/) , and UT's [Math Department](https://math.utk.edu/) for their support.

+++

## Copyright

[A Practical and Computational Introduction to Mathematical Cryptography](https://luisfinotti.org/pcimc/) © 2025 by [Luís R. A. Finotti](https://luisfinotti.org/) is licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)..
