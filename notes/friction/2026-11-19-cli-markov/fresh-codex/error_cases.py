import json
from fractions import Fraction
cases = [
 ('division_by_zero', '1/0', 'python'),
 ('zero_rational_denominator', 'Fraction(1,0)', 'python'),
 ('invalid_rational_text', "Fraction('one/half')", 'python'),
 ('malformed_syntax', "compile('x =', '<invalid>', 'exec')", 'python'),
 ('list_index', '[1,2][9]', 'python'),
 ('ragged_matrix', 'matrix(QQ, [[1,2],[3]])', 'sage'),
 ('wrong_entry_count', 'matrix(QQ, 2, 2, [1,2,3])', 'sage'),
 ('negative_dimensions', 'matrix(QQ, -1, 2, [])', 'sage'),
 ('invalid_matrix_entry', "matrix(QQ, [['nope']])", 'sage'),
 ('singular_inverse', 'matrix(QQ, [[1,2],[2,4]]).inverse()', 'sage'),
 ('nonsquare_inverse', 'matrix(QQ, [[1,2,3],[4,5,6]]).inverse()', 'sage'),
 ('incompatible_multiply', 'matrix(QQ, [[1,2]])*matrix(QQ, [[1,2]])', 'sage'),
 ('matrix_index', 'matrix(QQ, [[1]])[5,0]', 'sage'),
 ('invalid_matrix_power', "matrix(QQ, [[1,0],[0,1]])**'five'", 'sage'),
 ('direct_rational_json', "json.dumps(Fraction(1,3))", 'python')
]
results=[]
for name, code, domain in cases:
    if domain == 'sage' and 'matrix' not in globals():
        results.append({'case':name,'code':code,'status':'skipped','reason':'no Sage matrix API'})
        continue
    try:
        value=eval(code)
        results.append({'case':name,'code':code,'status':'accepted','value':str(value)})
    except Exception as e:
        results.append({'case':name,'code':code,'status':'error','type':type(e).__name__,'message':str(e)})
print(json.dumps(results,indent=2))
