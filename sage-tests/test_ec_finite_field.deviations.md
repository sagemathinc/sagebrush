# test_ec_finite_field: recorded deviations from Sage 10.9
test_ec_finite_field.out is SageMath 10.9's output (VM2, ~/sage-conda; oracle input e584ac80…, output a82a8ea3…) minus the lines of the statements below, which were dropped; every remaining line is Sage's, verbatim.
- S106, S107: a curve over Zmod(15) (not a field). Sage builds a generic curve (with no `order`); Sagebrush refuses: `NotImplementedError: elliptic curves over Ring of integers modulo 15 (not a field) are not available in Sagebrush yet`. A registered limit site.
- S108: a curve over GF(9). Sage: 16 points. Sagebrush refuses (`NotImplementedError`, registered): only prime fields here. Follow-up: curves over GF(p^k).
- S112: `abelian_group()`. Sage: `Additive abelian group isomorphic to Z/7 embedded in ...`. Not implemented in Sagebrush (an AttributeError, as for any missing method). Follow-up.
