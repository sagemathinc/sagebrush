import json

# Two transient states (new, engaged), then two absorbing outcomes
# (converted, abandoned). Rows of [Q R] sum exactly to one.
Q = matrix(QQ, [[1/2, 1/4], [1/5, 1/2]])
R = matrix(QQ, [[1/4, 0], [1/10, 1/5]])
I = identity_matrix(QQ, 2)
N = (I - Q).inverse()
B = N * R
t = N * vector(QQ, [1, 1])
second = (2*N - I) * t
variance = [second[i] - t[i]^2 for i in range(2)]
assert B == matrix(QQ, [[3/4, 1/4], [1/2, 1/2]])
assert list(t) == [15/4, 7/2]
assert variance == [155/16, 37/4]
P = matrix(QQ, [[1/2, 1/4, 1/4, 0],
                [1/5, 1/2, 1/10, 1/5],
                [0, 0, 1, 0], [0, 0, 0, 1]])
P5 = P^5
assert all(sum(P5[i, j] for j in range(4)) == 1 for i in range(4))

# Exact rationals are transported as strings: no float rounding and no
# dependence on the host JSON encoder knowing Sage's numeric classes.
def entries(M):
    return [[str(M[i,j]) for j in range(M.ncols())] for i in range(M.nrows())]

print(json.dumps({
    "states": ["new", "engaged", "converted", "abandoned"],
    "fundamental": entries(N),
    "absorption": entries(B),
    "expected_steps": [str(x) for x in t],
    "step_variance": [str(x) for x in variance],
    "transition_after_five_steps": entries(P5),
    "checks_passed": True
}, sort_keys=True))
