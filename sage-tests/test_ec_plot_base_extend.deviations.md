# test_ec_plot_base_extend: recorded deviations from Sage 10.9

None. Every line of test_ec_plot_base_extend.out is Sage's output: the oracle run on VM2 (SageMath 10.9) of this file with one more statement, on Nov 2 2026 (input 14509f6c, output 5c4eb8f5; frozen in /scratch/sage2-notes/ecqq/oracle1).

Not tested: the oracle's S38, `EllipticCurve([1/2, 3]).base_extend(GF(5))` (Sage: `Elliptic Curve defined by y^2 = x^3 + 3*x + 3 over Finite Field of size 5`). Sagebrush's curves over QQ have integral models only; the constructor refuses the coefficient 1/2 before base_extend is reached.

Sage's plot samples at random points (randomize=True); Sagebrush's are deterministic. The test therefore checks only what doesn't depend on the samples: the primitives, each line's first and last x (rounded to 6 digits), and that every point lies on the curve.
