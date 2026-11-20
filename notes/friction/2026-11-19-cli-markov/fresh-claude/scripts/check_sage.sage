import json, sys
rep = json.load(open(sys.argv[1]))
P = matrix(QQ, [[QQ(x) for x in r] for r in rep["P"]])
Q = P.submatrix(0, 0, 2, 2); R = P.submatrix(0, 2, 2, 2)
I = identity_matrix(QQ, 2)
N = (I - Q).inverse(); B = N * R; t = N * vector([1, 1])
var = (2*N - I) * t - vector([x^2 for x in t])
S = lambda M: [[str(x) for x in r] for r in M.rows()]
print(json.dumps({
    "N": S(N) == rep["fundamental_matrix_N"]["value"],
    "B": S(B) == rep["absorption_probabilities_B"]["value"],
    "t": [str(x) for x in t] == rep["expected_steps_to_absorption_t"]["value"],
    "var": [str(x) for x in var] == rep["step_count_variance"]["value"],
    "P5": S(P^5) == rep["P_power_5"]["value"],
}))
