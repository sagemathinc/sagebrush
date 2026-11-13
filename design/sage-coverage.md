# Sage coverage notes

What Sage mode doesn't do yet, written down so that the weekly triage can weigh it. The numbers per area are in the
function search's area lines (`web/docs/coverage/sage.json`, `web/coverage-areas.mts`). Sage's behaviour here is from
running Sage 10.10 as a black box, never from its source.

## Known gaps

### Elliptic curves over polynomial rings and function fields

**What fails.** `EllipticCurve(R, [...])` builds a curve only when R is QQ, ZZ or a prime field `GF(p)`/`Zmod(p)`; a
curve over RR comes only from `E.base_extend(RR)` (`EllipticCurve(RR, [1, 2])` is refused, though Sage builds it). Any
other base ring is refused:

    sage: R = QQ['Z','d']; Z = R.0; d = R.1
    sage: E = EllipticCurve(R, [0, 1+Z^2+d^2, 0, Z^2+d^2+d^2*Z^2, Z^2*d^2])
    NotImplementedError: elliptic curves over Multivariate Polynomial Ring in Z, d over Rational Field are not available in Sagebrush yet

**What Sage 10.10 does** with the same input:
- It builds the curve (a generic curve over the ring), its discriminant
  ($16 (d - Z)^2 (d - 1)^2 (d + 1)^2 (Z - 1)^2 (Z + 1)^2 (Z + d)^2$) and the points `E(0, d*Z)` and
  `E(d+Z+d*Z, (1+d)*(1+Z)*(d+Z))`.
- Negation works.
- **Adding those two points fails in Sage too**, with `AssertionError: bug: failed to compute elliptic-curve point
  addition`, as does doubling. The sum's coordinates are not polynomials: its $x$ has denominator $(Zd + Z + d)^2$.
- Over the fraction field (`E.base_extend(R.fraction_field())`) the same addition works.

**Minimal example** (the fraction-field form, which is what a user can do in Sage):

    sage: K = QQ['Z','d'].fraction_field(); Z, d = K.gens()
    sage: E = EllipticCurve(K, [0, 1+Z^2+d^2, 0, Z^2+d^2+d^2*Z^2, Z^2*d^2])
    sage: E(0, d*Z) + E(d+Z+d*Z, (1+d)*(1+Z)*(d+Z))

**Size, if taken up.**
- A generic Weierstrass curve over the rings Sagebrush already has (univariate and multivariate polynomial rings and
  their fraction fields): invariants, points, negation, and addition and multiplication over fields. About 350 to 500
  lines of Python and some 40 doctests.
- `FunctionField` itself is a separate and larger piece, and so are heights, torsion and rank over function fields.

Status: recorded, not scheduled; on the weekly triage list.
