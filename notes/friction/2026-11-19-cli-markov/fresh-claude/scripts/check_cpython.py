"""Independent check of the Sagebrush report using only CPython fractions."""
import json, sys
from fractions import Fraction as F

rep = json.load(open(sys.argv[1]))
P = [[F(x) for x in r] for r in rep["P"]]

def mul(A, B):
    return [[sum(A[i][k] * B[k][j] for k in range(len(B))) for j in range(len(B[0]))] for i in range(len(A))]

# 2x2 inverse of I - Q
a, b, c, d = 1 - P[0][0], -P[0][1], -P[1][0], 1 - P[1][1]
det = a * d - b * c
N = [[d / det, -b / det], [-c / det, a / det]]
R = [r[2:] for r in P[:2]]
B = mul(N, R)
t = [sum(r) for r in N]
var = [sum((2 * N[i][j] - (i == j)) * t[j] for j in range(2)) - t[i] ** 2 for i in range(2)]
P5 = P
for _ in range(4):
    P5 = mul(P5, P)

def s(M):
    return [[str(x) for x in r] for r in M]

checks = {
    "N": s(N) == rep["fundamental_matrix_N"]["value"],
    "B": s(B) == rep["absorption_probabilities_B"]["value"],
    "t": [str(x) for x in t] == rep["expected_steps_to_absorption_t"]["value"],
    "var": [str(x) for x in var] == rep["step_count_variance"]["value"],
    "P5": s(P5) == rep["P_power_5"]["value"],
}
print(json.dumps(checks))
sys.exit(0 if all(checks.values()) else 1)
