# sagebrush

Fast, certified engines for research mathematics, in Rust, for Python.
Permissively licensed (MIT OR Apache-2.0): use them anywhere, in anything,
from agents and notebooks to products. No C libraries; one abi3 wheel per
platform covers Python 3.9 and later.

This is an early release of [Sagebrush](https://github.com/sagemathinc/sagebrush),
which also runs in the browser at [sagebrush.space](https://sagebrush.space).

```python
>>> from sagebrush import nf, mf, ap, poly

>>> nf.bnf([-11, 0, 0, 1])              # Q[x]/(x^3 - 11): class group, regulator
{'cyc': [2], 'degree': 3, 'disc': -3267, 'h': 2, 'r1': 1, 'r2': 1, 'regulator': '5.5872066260609077619', 'w': 2}

>>> nf.factor_integer(2**128 + 1)       # ECM
[(59649589127497217, 1), (5704689200685129054721, 1)]

>>> nf.primes_above([-11, 0, 0, 1], 5)  # 5 = P_1 P_2 with residue degrees 1, 2
[{'e': 1, 'f': 1, 'p': 5, 'pi': [-1, 1, 0], 'pi_den': 1}, {'e': 1, 'f': 2, 'p': 5, 'pi': [1, 1, 1], 'pi_den': 1}]

>>> nf.lll([[1, 1, 1], [-1, 0, 2], [3, 5, 6]])
[[0, 1, 0], [1, 0, 1], [-1, 0, 2]]

>>> poly.factor([5, -1, -1, 1])         # x^3 - x^2 - x + 5 over Z
(1, [([5, -1, -1, 1], 1)])

>>> d = mf.newforms(389, 2, bound=6)    # newform orbits of S_2(Gamma0(389))
>>> d["status"], [(o["letter"], o["dim"]) for o in d["newforms"]]
('proven', [('a', 1), ('b', 2), ('c', 3), ('d', 6), ('e', 20)])

```

Polynomials are coefficient lists, constant term first.

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
- `sagebrush.poly`: factoring in Z[x] and F_p[x].

Results are checked against independent systems: PARI for class groups,
Sage and Magma for the rest, and LMFDB for modular forms.

## License

Copyright (c) 2026 SageMath, Inc. Licensed under either of the Apache
License, Version 2.0 or the MIT license, at your option.
