# test_ec_real_field: recorded deviations from Sage 10.9

None. Every line of test_ec_real_field.out is Sage's output: the oracle run on VM2 (SageMath 10.9) of this file with one more statement, on Nov 2 2026 (input 82659bed, output 2cb4e4f3; frozen in /scratch/sage2-notes/ecrr/oracle1).

S51-S57 (daybreak3's B1, the exact check of user coordinates) come from a second oracle run on VM2, frozen in /scratch/sage2-notes/ecrr/oracle-b1 (its messages cut at 200 characters, here at this file's 160).

Not tested: the oracle's S15, `type(P.xy()[0]) == type(RR(1))` (Sage: False). It compares Python implementation classes, which Sagebrush's RR doesn't mirror.

The arithmetic is Sage's, in IEEE double precision: lift_x (D = b^2 + 4f, its square roots, the y's sorted) and the group law (EllipticCurvePoint_field._add_), with the same operations in the same order. MPFR's 53-bit RNDN and IEEE doubles round + - * / and sqrt identically, so the printed values agree to every digit.
