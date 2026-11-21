import json
P = matrix(QQ, [[1/2,1/4,1/4,0], [1/5,1/2,1/10,1/5], [0,0,1,0], [0,0,0,1]])
Q = matrix(QQ, [[P[i,j] for j in range(2)] for i in range(2)])
R = matrix(QQ, [[P[i,j] for j in range(2,4)] for i in range(2)])
I = identity_matrix(QQ, 2)
N = (I-Q).inverse()
B = N*R
t = N*matrix(QQ, [[1],[1]])
m2 = (2*N-I)*t
v = matrix(QQ, [[m2[i,0]-t[i,0]^2] for i in range(2)])
P5 = P^5
# Canonical reduced exact rational strings: integer 'n' if denominator 1,
# otherwise 'n/d', with d positive. No JSON floating-point values.
def encode_matrix(A, rows, cols):
    return [[str(A[i,j]) for j in range(cols)] for i in range(rows)]
assert (I-Q)*N == I
assert Q*t + matrix(QQ,[[1],[1]]) == t
assert Q*B + R == B
assert Q*m2 + 2*Q*t + matrix(QQ,[[1],[1]]) == m2
report = {
    'schema_version': 1,
    'rational_encoding': {'type':'string', 'format':'n or n/d', 'normalization':'coprime numerator and denominator; positive denominator; integers omit /1'},
    'engine': {'product':'Sagebrush','distribution':'npm sagebrush','version':'0.10.1','mode':'sage'},
    'state_order':['new','engaged','converted','abandoned'],
    'transient_state_order':['new','engaged'],
    'absorbing_state_order':['converted','abandoned'],
    'step_count_definition':'Number of transitions until first entry into an absorbing state; zero if initially absorbing',
    'P':encode_matrix(P,4,4),
    'Q':encode_matrix(Q,2,2),
    'R':encode_matrix(R,2,2),
    'fundamental_matrix':encode_matrix(N,2,2),
    'absorption_probabilities_transient':encode_matrix(B,2,2),
    'absorption_probabilities_all_states':encode_matrix(B,2,2)+[['1','0'],['0','1']],
    'expected_steps_all_states':[str(t[i,0]) for i in range(2)]+['0','0'],
    'second_moment_steps_all_states':[str(m2[i,0]) for i in range(2)]+['0','0'],
    'variance_steps_all_states':[str(v[i,0]) for i in range(2)]+['0','0'],
    'P_power_5':encode_matrix(P5,4,4),
    'formulas': {'N':'(I-Q)^(-1)','B':'N R','t':'N 1','m2':'(2N-I)t','variance':'m2 - t elementwise squared'},
    'sagebrush_identity_checks_passed':True
}
with open('markov-report.json','w') as f:
    json.dump(report,f,indent=2)
print(json.dumps(report,indent=2))
