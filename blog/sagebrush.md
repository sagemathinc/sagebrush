---
title: Sagebrush is what I always wanted to write when I started SageMath. AI made it possible.
date: 2026-11-16
author: William Stein
author_url: https://wstein.org
description: An ultraportable, open source, permissively licensed rewrite of the most-used parts of Python, LaTeX, Magma, MATLAB, Mathematica, and R, with research mathematics at its core.
image: sagebrush.png
---
# Sagebrush is what I always wanted to write when I started SageMath. AI made it possible.

When I started SageMath decades ago, the plan was both simple and impossible: create a viable free, open source alternative to Magma, Maple, Mathematica and MATLAB.  My strategy: build the car instead of reinventing the wheel.   We got far by assembling the best open source math libraries in the world, and filling in the gaps with over a million lines of Python and Cython. But glue has a cost. Sage is big, challenging to install, and it needs a POSIX compiler toolchain, so fully supporting platforms like Windows feels perpetually out of reach. Moreover, the same algorithms are implemented in many different places in Sage.  I have always wanted something much better: an ultraportable, efficient implementation of the parts people actually use, so the whole thing is coherent and runs everywhere.  I want a Ford Raptor, not the hippie school bus I lived in as a child.

But I could never afford to create that.  Now I can.  And I've started. It's called **Sagebrush**.

Try it right now: open [sagebrush.space](https://sagebrush.space), pick Sage, and type `K.<a> = NumberField(x^3 + 14*x - 1)` and then `K.class_number()`.  You get `8`, computed by a new engine running inside your browser tab.  Nothing to install, no account.

In one sentence: I want Sagebrush to be an ultraportable, open source, permissively licensed rewrite of the most-used parts of Python, LaTeX, Magma, MATLAB, Mathematica, and R, with research mathematics at its core.  In short: _mathematical software ecosystems, rewritten to run anywhere_.

Year after year I have tried many approaches to this problem, but always had to give up due to the daunting scale, sometimes after thousands of hours of extremely hard work.   The situation fundamentally changed with Claude Opus 5.5.

In one day, Opus took code and algorithms I spent months developing for computing with Hilbert modular forms, implemented them, made them much faster, and significantly generalized the code.   The reality of mathematical software development in November 2026 is vastly better than anything I could have possibly imagined happening in this century.

## What it is

You open a notebook or whiteboard, and the language menu offers Python, Sage, Magma and MATLAB.  Support for R and Mathematica code is under development.  By default, your code runs in the page itself. While writing this post I typed

```
E = EllipticCurve('389a')
print(E.conductor(), E.rank())
print(factor(2^128 + 1))
```

and got `389 2`, `59649589127497217 * 5704689200685129054721`, all inside the browser tab. Magma and MATLAB cells work the same way.

Under the language layer is a new mathematical engine, written in Rust: class groups and units, modular symbols and newforms, Galois groups, elliptic curves, numerical and exact linear algebra, polynomials.  It was written from papers and books, with no code from Magma, PARI, Sage, Singular, FLINT or GMP, so when it agrees with those systems, that agreement was reached independently.  

Unlike Sage and its components such as GAP, PARI and Singular, Sagebrush is not GPL licensed.  It is MIT / Apache licensed, so you can build it into anything, including commercial products.

## Why a rewrite?

Wrapping existing systems is what I did with Sage. I'm proud of that approach and it was right for its time. But wrapping means your software can only run where every wrapped piece runs, and you inherit every piece's size, build system and quirks: gigabytes versus megabytes.

A rewrite lets the same code run in three places:

- **A browser.** The engines compile to WebAssembly, so a notebook is a web page, and sharing your work means sending a link.
- **A computer.** `pip install sagebrush` or `npx sagebrush`.
- **A server.** Self-hosting with file sync and publishing, for companies and institutions that need to run Sagebrush themselves.  This part is commercial; together with the hosted service, it's how Sagebrush may pay for itself.

And where something isn't implemented yet, or isn't proven, you get a precise error, not a wrong answer.  Ask for the rank of the first rank 3 elliptic curve, of conductor 5077:

```
sage: E = EllipticCurve([0,0,1,-7,6])
sage: E.rank()
NotImplementedError: the rank is 3 assuming GRH (the 2-Selmer group); proof=False accepts it
```

`E.rank(proof=False)` gives `3`.

## Rewriting Python.  Rewriting LaTeX.

Sagebrush doesn't wrap CPython; it has its own Python, built on CPython's own grammar, so you get the same syntax errors down to the column, and pure-Python packages like mpmath pass their own test suites.  Sage, Magma and MATLAB each get their own parser on top of that, and they all share one runtime.  We're also rewriting much of NumPy, SciPy and pandas, and the Rust engine is shared underneath: Sage's and Magma's integer factorization run on the same code.

LaTeX too.  Open a `.tex` file and the rendered document appears almost instantly beside its source, with no TeX installation anywhere, and it follows as you type.  The part I'm most excited about: the Sage, Python and Magma code in the document runs as well, in the browser, so a paper's numbers can be computed live by software a reader can open in a tab.  You can even give a Beamer talk with live interactive widgets.

## Why now?

Two reasons: AI agents and AI agents.

First, AI agents make this feasible. A rewrite of this breadth used to need a large, well-funded team working for many years and would have cost tens of millions of dollars. Now a very small team (just me!) can do it. I drive the direction and the results; the agents do an enormous amount of the careful, tedious work, and computations are checked against existing systems.  There's extensive review combined with mutation and randomized testing.

Second, agents are now first-class users of math software. Sagebrush is built for both agents and people.  `uvx sagebrush-mcp` gives any agent the engine and your documents as tools, with no account needed, and [llms.txt](https://sagebrush.space/llms.txt) tells an agent how everything works.

## Try it

- [Examples](https://sagebrush.space/examples/): notebooks in Python, Sage, Magma and MATLAB, whiteboards, and [LaTeX documents](https://sagebrush.space/examples/latex/).  Open one and change it.

This is an early alpha: it isn't security-hardened yet, each language is a useful subset rather than the whole thing, R and Mathematica aren't in the menu yet, and the desktop app and self-hosting are still coming.  There are bugs.

If there's a computation you do every week and Sagebrush can't do it yet, I'd like to know.  Try it at [sagebrush.space](https://sagebrush.space), break it, and tell me what's missing.

-- William
