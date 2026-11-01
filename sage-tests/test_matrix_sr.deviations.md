# test_matrix_sr: recorded deviations from Sage 10.9

All 14 lines below were APPROVED by @sagebrush, line by line, on Nov 1 2026 (verdicts on e1efc66a = this file at 6cd451a6, each checked against out6):
- print order only, the same value: 9, 10, 14, 33, 34, 36, 38, 39, 40, 43, pending 4p;
- a different method with an equal value: 78, 80, pending 4b-2;
- recorded gaps, refused before any work by plan r3 (T4, A5): 13 and 81. These are MISSING FEATURES, not equal values, pending 4b-2.

Checked against real Sage 10.9 on Nov 1, in the counted VM2 oracle run of this exact file (/scratch/sage2-notes/kernel/oracle/out6, oracle.out be4b0a38; input 8e5999c3). 80 of the 94 lines of test_matrix_sr.out are Sage's output. The 14 below are ours, each with its reason and the lane that is to turn it into Sage's.

Print order (the engine's printer orders some products and sums differently from Sage's Pynac; the values and the algorithm, step for step, are Sage's). Lane 4p (engine/sym/src/print.rs: lead_symbol, and the tie-break between sum terms) is to turn these into Sage's:
- Line 9, `T.det()`: Sage `-a*b^2 + (a^2 - b^2)*a`, ours `(a^2 - b^2)*a - a*b^2` (the order of terms).
- Line 10, `G.det()`: Sage `-(f*h - x*y)*a + (c*h - b*y)*d + (b*f - c*x)*g`, ours `-(b*y - c*h)*d + (b*f - c*x)*g + a*(-f*h + x*y)`. This is the same expansion, along the first column, with terms and factors in a different order.
- Lines 14 and 43, `B.inverse()` and `B.solve_right(I)`: Sage `1/(x^2*(y - 1/x))`, `-1/(x*(y - 1/x))`, ours `1/((y - 1/x)*x^2)`, `-1/((y - 1/x)*x)` (the order of factors in a denominator).
- Lines 36 and 38, `B.solve_right(v)` and `B.solve_left(v)`: the same factor order.
- Lines 33, 34, 39 and 40 (echelon_form, rref and the solves of [[x, 1, 2], [1, y, 3]]): Sage `2/x + (2/x - 3)/(x*(y - 1/x))` and `-(2/x - 3)/(y - 1/x)`, ours `2/x - (-2/x + 3)/((y - 1/x)*x)` and `(-2/x + 3)/(y - 1/x)`. The factor order differs, and Sage keeps a negated sum where ours distributes the sign.

Sage's division-free algorithm (Sage's det for n >= 4 and its adjugate for n >= 3 come from its 'df' characteristic polynomial path, unsimplified). Lane 4b-2 is to implement it and turn these into Sage's:
- Line 13, the 4x4 det: Sage `x^4 - 3*x^2 + 1`, ours NotImplementedError (plan r3 T4: refused before any work). This is a missing feature, not an equal value.
- Line 78, `G.adjugate()` (3x3): Sage `[-f*h - a*(x + y) + a*x + a*y + x*y ...]`, ours the cofactor transpose `[-f*h + x*y ...]`. They are equal in value: line 79's check `adj(G)*G - det(G) == 0` is True for both.
- Line 80, the 4x4 adjugate: the same (Sage `[4*x^3 - (3*x^2 - 2)*x - 4*x ...]`, ours `[(x^2 - 1)*x - x ...]`).
- Line 81, the 5x5 adjugate: Sage a value, ours NotImplementedError (plan r3 A5: refused before any minor). This is a missing feature, not an equal value.

Fixed after the oracle (now Sage's, (c)): line 10's expansion (the first column, Sage's formula), line 82 (the 0 x 0 adjugate is a TypeError), and lines 93-94 (the zero test's trig_reduce proof stage, astra3's A3 ruling).
