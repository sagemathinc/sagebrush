# Absorbing Markov chain report computed with Sagebrush (Sage mode).
# State order: new, engaged, converted, abandoned (last two absorbing).
import json, sys

states = ['new', 'engaged', 'converted', 'abandoned']
P = matrix(QQ, [[1/2, 1/4, 1/4, 0],
                [1/5, 1/2, 1/10, 1/5],
                [0, 0, 1, 0],
                [0, 0, 0, 1]])

# sanity: row-stochastic
assert all(sum(P.row(i)) == 1 for i in range(4))
t = 2  # transient states first
# WORKAROUND: Sagebrush 0.10.1 Matrix has no .submatrix(); use slicing
Q = P[0:t, 0:t]
R = P[0:t, t:4]
I = identity_matrix(QQ, t)
N = (I - Q).inverse()
B = N * R
ones = vector(QQ, [1] * t)
tvec = N * ones
# Var = (2N - I) t - t_sq
tsq = vector(QQ, [x^2 for x in tvec])
var = (2*N - I) * tvec - tsq
P5 = P^5

# independent internal checks
assert (I - Q) * N == I
assert all(sum(B.row(i)) == 1 for i in range(t))
assert P5 == P*P*P*P*P
assert all(sum(P5.row(i)) == 1 for i in range(4))

def q(x):
    x = QQ(x)
    return str(x)

def qm(M):
    return [[q(x) for x in row] for row in M.rows()]

report = {
    "schema": "absorbing-markov-report/v1",
    "rational_encoding": "Each exact rational is a JSON string 'p/q' in lowest terms with q>0, or 'p' when q==1 (Sage QQ str()). Parse with Python fractions.Fraction(s).",
    "states": states,
    "transient_states": states[:t],
    "absorbing_states": states[t:],
    "P": qm(P),
    "Q": qm(Q),
    "R": qm(R),
    "fundamental_matrix_N": {"rows": states[:t], "cols": states[:t], "value": qm(N)},
    "absorption_probabilities_B": {"rows": states[:t], "cols": states[t:], "value": qm(B)},
    "expected_steps_to_absorption_t": {"rows": states[:t], "value": [q(x) for x in tvec]},
    "step_count_variance": {"rows": states[:t], "formula": "(2N - I) t - t_sq", "value": [q(x) for x in var]},
    "P_power_5": {"rows": states, "cols": states, "value": qm(P5)},
    "engine": {"tool": "sagebrush", "mode": "--sage", "version": None},
}
print(json.dumps(report, indent=1))
