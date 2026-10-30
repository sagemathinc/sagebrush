# sagebrush

Fast, certified engines for research mathematics, in Rust, for Python.
Permissively licensed (MIT OR Apache-2.0): use them anywhere, in anything,
from agents and notebooks to products. No C libraries; one abi3 wheel per
platform covers Python 3.10 and later.

This is an early release of [Sagebrush](https://github.com/sagemathinc/sagebrush),
which also runs in the browser at [sagebrush.space](https://sagebrush.space).

```python
>>> from sagebrush import nf, mf, ap, poly, linalg

>>> nf.bnf([-11, 0, 0, 1])              # Q[x]/(x^3 - 11): class group, regulator
{'assumes': ['GRH'], 'certified': True, 'cyc': [2], 'degree': 3, 'disc': -3267, 'h': 2, 'r1': 1, 'r2': 1, 'regulator': '5.5872066260609077619', 'w': 2, 'w_proven': True}

>>> nf.factor_integer(2**128 + 1)       # ECM
[(59649589127497217, 1), (5704689200685129054721, 1)]

>>> nf.primes_above([-11, 0, 0, 1], 5)  # 5 = P_1 P_2 with residue degrees 1, 2
[{'e': 1, 'f': 1, 'p': 5, 'pi': [-1, 1, 0], 'pi_den': 1}, {'e': 1, 'f': 2, 'p': 5, 'pi': [1, 1, 1], 'pi_den': 1}]

>>> nf.lll([[1, 1, 1], [-1, 0, 2], [3, 5, 6]])
[[0, 1, 0], [1, 0, 1], [-1, 0, 2]]

>>> poly.factor([5, -1, -1, 1])         # x^3 - x^2 - x + 5 over Z
(1, [([5, -1, -1, 1], 1)])

>>> linalg.det([[2, 7, 1], [8, 2, 8], [1, 8, 2]]), linalg.charpoly([[0, 1], [-1, 0]])
(-114, [1, 0, 1])

>>> linalg.solve([[2, 1], [1, 3]], [[1], [2]])   # exact, over QQ
[[Fraction(1, 5)], [Fraction(3, 5)]]

>>> d = mf.newforms(389, 2, bound=6)    # newform orbits of S_2(Gamma0(389))
>>> d["status"], [(o["letter"], o["dim"]) for o in d["newforms"]]
('proven', [('a', 1), ('b', 2), ('c', 3), ('d', 6), ('e', 20)])

```

Polynomials are coefficient lists, constant term first.

## Sage-compatible: `sagebrush.sage`

For Sage users, `sagebrush.sage` is a namespace with Sage's names, behaviour
and printing, for what Sagebrush implements: number fields, polynomials,
matrices, modular forms and symbols, elliptic curves, Dirichlet characters,
integers, plotting.

```python
>>> from sagebrush.sage import *
>>> factor(2026)
2 * 1013
>>> x = PolynomialRing(QQ, 'x').gen()
>>> K = NumberField(x**3 + 17*x + 1, 'a')
>>> K.class_group()
Class group of order 3 with structure C3 of Number Field in a with defining polynomial x^3 + 17*x + 1
>>> K.regulator()
2.83341678218613
>>> K.factor(11)
(Fractional ideal (11, a + 3))^2 * (Fractional ideal (11, a + 5))
>>> Integer(2026).is_prime(), Integer(2026) / 4
(False, 1013/2)
>>> EllipticCurve('389a1').rank()
2

```

This is plain Python, without Sage's preparser: write `x**3` (`x^3` is xor
in Python, and raises an error here as in Sage), `Integer(2)/3` for a
rational (`2/3` is a float), and `K = NumberField(f, 'a'); a = K.gen()` for
`K.<a> = NumberField(f)`. Integers from `Integer(n)` or `ZZ(n)` have Sage's
methods. The output is checked line by line against Sage itself: Sage's
own preparser turns Sagebrush's Sage test files into plain Python, and
their output under `sagebrush.sage` must equal Sage's.

## For AI agents: `sagebrush-mcp`

This package installs `sagebrush-mcp`, a
[Model Context Protocol](https://modelcontextprotocol.io) server with no
other dependencies.

- **Claude Code:** `claude mcp add sagebrush -- sagebrush-mcp`
- **Other clients:** `{"mcpServers": {"sagebrush": {"command": "sagebrush-mcp"}}}`

Its tools:
- `sage`: Sage syntax in a persistent session; returns printed output, the
  last value and SVG plots.
- `python`: the same session, as plain Python.
- `factor`, `number_field`, `newforms`: shortcuts.
- `guide`: what is implemented. `reset`: clear the session.
- `run_status`, `run_result`, `run_cancel`, `run_list`, `run_keep`: runs.
- `latex_comments_list`, `_show`, `_add`, `_reply`, `_resolve`, `_reattach`:
  comments on a `.tex` in the person's Sagebrush workspace, through the page
  paired with `workspace_connect` (the format: `web/latex/COMMENTS-FORMAT.md`).

A `sage` or `python` call is a run. The call waits up to `wait` seconds (60
by default). If the computation hasn't ended by then, the call returns a
ticket, the run's handle, and the computation keeps running: `run_result`
waits for it, and `run_cancel` interrupts it (the session keeps its
variables). Only a `run_deadline` you give, or a cancel, stops a run.
`timeout` is the old name of `wait`. Every result says how many runs are
running. The shortcut tools still have time limits.

Runs are kept in `~/.cache/sagebrush/runs/` (or `$SAGEBRUSH_RUNS_DIR`), which
is bounded: by default 2 GiB, 200 runs and 7 days. Only your Unix user can
read the directory. Collaborators who share that user, as in a shared
cocalc.ai project, can list, read and cancel your runs. A run started by another server, or
by one that has exited, is listed with liveness "unknown". The session also
works on its own
(`sagebrush.session.Session`), and `sagebrush.preparse.preparse` turns Sage
syntax into Python.

On CPython 3.10, 3.11, 3.12 before 3.12.10 and 3.13 before 3.13.3, a
thread's `print()` racing the end of a run could write to a freed stream
([CPython gh-130163](https://github.com/python/cpython/issues/130163)); the
session's process makes `print()` safe there, but a thread's own lower-level
writes at that moment (an uncaught exception's traceback, `input()`) can
still crash it, and the session is then restarted, without its variables.
Python 3.12.10 or later, or 3.13.3 or later, has the fix.

On Python 3.10 and 3.11, importing `sagebrush` adds two methods of 3.12's
`fractions.Fraction` that its Sage layer uses, `_from_coprime_ints` and
`is_integer`, where they are missing; `int.is_integer` (also 3.12) is not
added.

## Benchmarks: `sagebrush bench`

This package also installs `sagebrush`, whose `bench` command reruns the
benchmarks behind Sagebrush's performance claims, against the other systems
installed on the machine:

    sagebrush bench --list               # the suites and the claims they back
    sagebrush bench --quick              # every suite, small cases (a minute or two)
    sagebrush bench imagquad realquad    # some suites, standard cases
    sagebrush bench nf --large --json run.json
    sagebrush bench --markdown run.json  # a saved run as tables

The competitors (PARI/GP's `gp`, FLINT, Sage) run only if they are
installed, each in its own process; a missing one shows "not installed".
FLINT is reached through a small C program compiled against it
(`pkg-config flint`). Every answer is compared across the engines, and a
disagreement makes the run fail. The output includes the machine, the
versions, the load average, and the median and range of each case;
`--json` keeps every sample.

## Engines

- `sagebrush.nf`: number fields: maximal orders, prime ideals, class groups,
  units and regulators (assuming GRH, with a field-specific bound for the
  generators), quadratic class groups to |D| ~ 10^60; integer factoring
  (ECM); Hermite and Smith forms, LLL; complex roots to any precision.
- `sagebrush.mf`: modular forms of weight k >= 2 with character:
  dimensions, exact Hecke characteristic polynomials, newform orbits, trace
  forms.
- `sagebrush.modsym`: weight-2 modular symbols for Gamma0(N).
- `sagebrush.ap`: traces of Frobenius a_p of elliptic curves over Q.
- `sagebrush.poly`: factoring in Z[x] and F_p[x]; products, gcds and exact
  division in Z[x].
- `sagebrush.linalg`: exact matrices over ZZ and QQ: `det`, `rank`, `rref`,
  `solve`, `inverse`, `charpoly`, `kernel` (multimodular and p-adic, every
  answer certified).

Results are checked against independent systems: PARI for class groups,
Sage and Magma for the rest, and LMFDB for modular forms.

## Memory

There are no time limits on a computation. A few operations check, before
they start, that their memory fits a share of this machine's memory as the
process sees it: the smallest of the cgroup limit, `RLIMIT_AS` and
`RLIMIT_DATA`, a Windows job's limit, and physical memory. One matrix may
use at most a quarter of that figure, for example. When none of these can
be read, the figure is a nominal 1 GiB. A factorization of a polynomial
over Z, unless given its own limits, may use half of the memory observed
free, less a reserve, or a quarter of what is free when that is more.
These figures are observations, not reservations: another process can
still take the memory.

## License

Copyright (c) 2026 SageMath, Inc. Licensed under either of the Apache
License, Version 2.0 or the MIT license, at your option. The package also
contains John Cremona's elliptic curves of conductor below 1000 (from
ecdata, under the Artistic License 2.0) and the Rust crates its engine is
built from, each under its own license: see `THIRD-PARTY-NOTICES.txt`.
