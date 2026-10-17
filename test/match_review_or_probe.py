# astra's match-statement review probe (or_probe.py, 35611c48), compared with CPython 3.14 by test/match.test.ts
patterns = [
    '[x, ([x] | [x])]',
    '[([x] | [x]), x]',
    '[x, ([y] | [y])]',
    '[([x] | [y]), z]',
    '[([a, b] | [b, a]), c]',
    '([a, ([b] | [b])] | [a, ([b] | [c])])',
    '([a, ([b] | [b])] | [a, ([b] | [b])])',
    '[z, ([a, ([b] | [b])] | [a, ([b] | [b])]), z]',
    '[z, ([a, ([z] | [z])] | [a, ([z] | [z])])]',
    '[z, ([a, ([b] | [b])] | [a, ([b] | [b])]), b]',
    '([x] | [x]) as x',
    '([x] | [x]) as y',
    '([x] | [x]) | ([x] | [x])',
    '([x] | [x]) | ([y] | [y])',
    '[a, (b | 1)]',
    '[a, (1 | b)]',
    '["é", x, x]',
    '["é", ([x] | [y])]',
    '{"é": a, "é": b}',
]
for i,p in enumerate(patterns):
    src='def f(s):\n match s:\n  case '+p+': return tuple(sorted(locals().items()))\n'
    try:
        compile(src,'<or>','exec')
        print(i,'ok')
    except SyntaxError as e:
        print(i,repr((e.msg,e.lineno,e.offset,e.end_lineno,e.end_offset)))

def matched(s):
    match s:
        case [z, ([a, ([b] | [b])] | [([b] | [b]), a])]:
            return z,a,b
        case _: return 'miss'
for s in [[9,[1,[2]]], [9,[[2],1]], [9,[1,2]], [9,[1,[[2]]]]]:
    print('values',repr(s),repr(matched(s)))
