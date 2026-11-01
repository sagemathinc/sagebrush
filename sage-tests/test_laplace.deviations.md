# test_laplace: recorded deviations from Sage 10.9
Checked against real Sage 10.9 on Nov 1 (the VM2 oracle; /scratch/sage2-notes/kernel/oracle, COMPARE.txt 24577be7). Every other line of test_laplace.out is Sage's output. Grader ruled these lines (b) (04f715e1) and @sagebrush approved them (sage-oracle-b-approvals.md).
- Line 17, `inverse_laplace(exp(-2*s)/s, s, t)`: Sage returns `ilt(e^(-2*s)/s, s, t)` unevaluated. Ours returns `heaviside(t - 2)`, because the delay rule F(s) e^(-cs) -> heaviside(t - c) f(t - c) holds for a known real c >= 0, and it gives the right inverse where Sage gives none.
- Line 22, `inverse_laplace(exp(-2*s)/(s^2 + 1), s, t)`: Sage returns `ilt(...)` unevaluated. Ours returns `heaviside(t - 2)*sin(t - 2)`, by the same delay rule.
- Line 27, `inverse_laplace(exp(-a*s)/s, s, t)` under `assume(a > 0)`: Sage returns `ilt(...)` unevaluated. Ours returns `heaviside(-a + t)`, because a > 0 is known, so the delay rule applies.
- Line 31, `laplace(heaviside(t - a), t, s)` with a unconstrained: Sage raises TypeError (Maxima asks "Is a positive, negative or zero?"). Ours returns `laplace(heaviside(-a + t), t, s)` unevaluated. Both refuse; ours doesn't need an interactive question answered.
- Line 34, `laplace(heaviside(t - a)*t, t, s)` with a unconstrained: Sage raises TypeError (the same question). Ours returns it unevaluated, an equivalent refusal.
