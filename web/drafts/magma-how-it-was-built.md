<!-- description: How Sagebrush implements the Magma language, clean room: a translator to Python, Magma's values and universes modelled from public documentation, every behaviour checked against Magma 2.18-5 run only as a black box, and a rule to refuse rather than guess. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code, tests, coverage measurements and review history of the Sagebrush project, led by William Stein (SageMath, Inc.). DRAFT: not linked or published; publishing is William's decision. -->
# How Sagebrush's Magma mode was built

:::disclaimer
**Sagebrush is not Magma, and has nothing to do with the makers of Magma.**

On these pages, "Magma" means the programming language only. Sagebrush's
Magma mode is an independent implementation of that language. It was
written from Magma's public documentation (for names, signatures and
meaning; none of its text or examples was copied), and its behaviour was
checked by
running Magma 2.18-5 as a black box: giving it inputs and reading its
outputs. It contains no code from the Magma computer algebra system, is not
derived from Magma's source code, and was written without reading it.

Magma is developed by the Computational Algebra Group at the University of
Sydney. Sagebrush is not a product of that group or of the University of
Sydney, and is not affiliated with, sponsored by or endorsed by either.
:::

*Code: `src/magma.ts` (the translator, about 1,800 lines), `lib/_magma.py`
(the runtime, about 8,800 lines), `lib/_magma_docsearch.py` (help and
examples), `lib/_magma_names.py` (the names of Magma's intrinsics).
Measurements: `design/magma-coverage.md`. Tests: `magma-tests/`,
`test/magma.test.ts`, `test/magma-examples.test.ts`.*

Type this into a Sagebrush notebook in Magma mode:

```magma
P<t> := PolynomialRing(Rationals());
(t + 1)^3;
Factorization(720);
```

What comes back is what Magma prints:

```
t^3 + 3*t^2 + 3*t + 1
[ <2, 4>, <3, 2>, <5, 1> ]
```

The rest of this page describes how that was achieved, how it was checked,
and how much of Magma is not there. In short: Magma programs are translated
to Python and run on a runtime library that models Magma's values and its
printing. Every behaviour was compared with what Magma 2.18-5 prints for
the same input. Where Sagebrush can't be sure of Magma's answer, it says so
instead of guessing.

## 1. A language, built clean room

Magma is two things: a programming language, and a very large library of
mathematics written in it and in C. Sagebrush implements the first, the
language, and a small part of the second, on top of its own mathematics.

The work followed fixed rules, kept for the whole project:

- **What was used.** Magma's Handbook (its public documentation), for the
  names of the intrinsics, their signatures and their documented meaning;
  published mathematics papers; and Magma 2.18-5 as a black box: a program
  goes in, printed output comes out, and only the output is looked at. No
  text or example from the Handbook was copied into Sagebrush.
- **What was never used.** Magma's source code. The installed copy of
  Magma that served as the black box ships much of its library as source
  files; they were never opened, listed, searched or copied, for any
  purpose. The same applied to the source of other systems with
  incompatible licences.
- **Tests use our own inputs.** No Handbook example is in the repository.
  The Handbook's examples were run under both systems to *measure* coverage
  (section 6), but that corpus is kept outside the repository, and only
  counts and names go into the coverage report.
- **Nothing of Magma's internals goes into the repository**: not its error
  tracebacks, and not the paths of its library files.

All the help text and every example in Magma mode's help were written for
Sagebrush. The names of the intrinsics are Magma's, because a program has
to be able to call them.

## 2. A translator to Python

A Magma program goes through a hand-written lexer and a recursive-descent
parser, and comes out as Python source. That source then runs like any
other cell in Sagebrush: in the browser, in Node, on the command line
(`sagebrush --magma`), in notebooks and in the Jupyter kernel. Translating
rather than interpreting means Magma code gets what Python code in
Sagebrush already has: the sandbox, interrupts, notebooks and boards.

The translator carries Magma's own semantics:

- Sequences are 1-based and have **value semantics**: `T := S;` copies, so
  changing `T` doesn't change `S`.
- **Reference arguments**: `Append(~S, x)` changes `S` in place, and a user
  procedure gets its `~` arguments back.
- **Multiple return values**: an expression uses the first; an expression
  statement prints them all; `a, b := f(x);` takes them in turn.
- `:=` and `op:=`, `if`/`for`/`while`/`repeat`/`case`, `function`,
  `procedure` and `func< >`, `$$` recursion, `select`, `&+` reductions,
  comprehensions `[ e : x in S | c ]`, ranges `[a..b by c]`, and generator
  names `R<x> := ...`.
- **Errors behave as Magma's.** Read from standard input, every error is
  reported and the session goes on, as Magma's interactive session does.
  Read from a file, a runtime error stops the program but an undeclared
  identifier doesn't. In a notebook cell, any error stops the cell.

A Magma name never reaches a Python one: `len`, `sum` or `list` in a Magma
program are undeclared, as in Magma, not Python's builtins.

## 3. Values and universes

Most of the work, and most of the bugs found in review, were in modelling
Magma's values, and above all their **universes**.

A Magma sequence or set has a universe: the structure its elements belong
to. `[1/2, 3]` is a sequence over the rationals; `[GF(7) | 2, 9]` is over
the field with 7 elements and holds 2 and 2. The universe decides what
can be put in later, how elements print, and what functions accept. `Gcd`
of a sequence of integers is a number. `Gcd` of a sequence over the
rationals is Magma's error "GCD not defined for field".

So the runtime keeps, for each collection, what is known of its universe:

- **declared** (`[Rationals() | ]`), which never changes;
- **inferred** from its first elements, and kept after they are removed: a
  sequence that held `1/2` is still over the rationals when emptied;
- **written empty** (`[]`, `{}`): no universe yet. Magma treats these
  differently from an emptied sequence: `Gcd([])` is "Illegal null
  set/sequence", but `Gcd` of an emptied sequence of integers is 0.
- **unknown**: where Sagebrush can't tell which of these Magma would
  have.

Every operation that makes a collection from others has to carry this
along, and each was checked against Magma: copies, `Setseq` and `Seqset`,
`Sort` (with and without a comparison function), `Reverse`, selections,
`cat`, `join`, `meet`, `diff`, `sdiff`, images under maps, and what
`Append`, `Include` and `Insert` do with the element they are given.

Some of the rules found by probing were not obvious:

- `{Integers() | } join {GF(7) | }` is over GF(7), but the rationals and
  GF(7) have no common universe, so joining those is an error.
- `{GF(7) | } join {4, 11}` is `{ 4 }`: the integers are put in GF(7), and
  4 and 11 become the same element.
- The image of a set under a map is over the map's codomain, even when the
  image is empty. For a map into a set (rather than a ring), a nonempty
  image is over the set's universe, but an empty one is over the set
  itself.
- A number put in a sequence over $\mathbb{Q}[x]$ becomes a constant
  polynomial: after `Append(~S, 2)`, `S[1] div 3` is $2/3$.

Each of these was a wrong answer at some point, found by comparing with
Magma, and fixed.

**Intrinsics with several signatures.** Many Magma intrinsics mean
different things for different argument types: `Trace` of a matrix, of a
number field element, or of a finite field element. The runtime registers
each signature separately and dispatches on the argument types, as Magma
does. Arguments no signature accepts give Magma's own error, "Bad argument
types", with the argument types listed as Magma lists them, including a
`~` for an argument passed by reference.

**Printing** follows Magma's layout: 80-column lines, the way sequences and
sets wrap, how rationals, polynomials and finite field elements print, and
the exact wording and placement of runtime errors.

The arithmetic underneath is Sagebrush's own: the integers, rationals,
polynomials, finite fields, matrices and number theory that its Sage mode
also uses. Magma mode adds Magma's semantics and printing on top.

## 4. Checking against Magma

Every behaviour was checked by running the same input through Magma 2.18-5
and through Sagebrush and comparing what they print. This happens at
several levels:

- **Probes.** A change starts with a list of cases (for example, every way
  a collection can end up empty, and what `Gcd` does with each). The list
  is run through Magma first and then through Sagebrush. The cases are our
  own inputs, and only Magma's output is used.
- **Program tests** (`magma-tests/`): Magma programs whose output must
  match Magma's byte for byte.
- **Unit tests** (`test/magma.test.ts`), with expected outputs taken from
  Magma's output for the same input.
- **Help examples.** Each of the 172 intrinsics in Magma mode's help has at
  least one example: 178 in all. In CI, each example runs in a fresh
  session and must print exactly what it shows. Magma's own output for the
  same input, recorded once, must also be identical. So help can't show a
  wrong answer, or one that has gone stale.
- **Review.** Every change was reviewed by two independent reviewers: one
  for correctness, who ran their own probes against Magma, the change and
  its parent, and one for limits and robustness. A change that made any
  previously correct result wrong, or produced a plausible wrong answer,
  was held until fixed. Most of the rules in section 3 came out of those
  holds.

## 5. Refuse rather than guess

A computer algebra system that prints a plausible wrong answer is worse
than one that prints nothing. So Magma mode follows one rule throughout:
**where Sagebrush can't be sure of what Magma would answer, it refuses,
and says so in words.** Some examples:

- An intrinsic Magma has and Sagebrush doesn't:
  `'Rotate' is a Magma intrinsic not implemented in Sagebrush`.
- A signature not implemented yet, or a structure Sagebrush can't model as
  a universe: `the image of a set under a map to this codomain is not
  supported yet`.
- An empty collection whose universe Sagebrush doesn't know, given to
  `Gcd`: a refusal, never a guessed 0 or 1.
- Work beyond a stated bound: a comprehension of more than a fixed number
  of elements, a polynomial of very high degree over a finite field, or a
  range endpoint with too many digits. Each is refused before the work is
  started, so a program can't exhaust the browser's memory.

Where Sagebrush does answer, the answer is meant to be Magma's. A refusal
is a known gap. A different answer is a bug.

## 6. What is not there

Magma's library is enormous, and Magma mode covers a small part of it.
Measured honestly:

- **Names.** Magma's Handbook documents about 5,600 intrinsics. Magma mode
  provides 172 of them.
- **Use.** Counting how many of the Handbook's 2,260 examples call each
  intrinsic, 27 of the 50 most-used are provided, and the provided ones
  account for about a third of all intrinsic calls in those examples.
- **The Handbook's examples as a whole.** The last full measurement
  (`design/magma-coverage.md`) ran every Handbook example under both
  systems. Only a few percent of their outputs matched byte for byte,
  mostly because an example calls something Sagebrush doesn't have.
  Commonly used but missing: projective spaces and schemes, function
  fields, free and dihedral groups, root data and Lie algebras,
  differential operator rings, L-series, and general vector spaces.
- **Language features.** `try ... catch` is not supported yet. Some
  intrinsics on sequences, such as `Rotate` and `Prune`, are not
  implemented.
- **Known differences.** The order in which a set of polynomials prints
  can differ from Magma's. Multisets that mix coerced elements don't
  always count multiplicities as Magma does.
- **Refusals where Magma answers.** For example, dividing a polynomial
  over the integers by a number. These are listed and are being worked
  through, most-used first.

The ranking by use decides what comes next: the most-used missing
intrinsics that are well defined and cheap to build on what is already
there come first.
