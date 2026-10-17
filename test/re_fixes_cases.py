# python-re-fixes, compared with CPython 3.14 (test/re-fixes.test.ts):
# CPython's parse errors, with their positions (group references, octal
# escapes, inline flags, repeats, look-behind widths) and fix_flags; then
# match, search, fullmatch, findall, sub, split and finditer of patterns
# where JS's RegExp and sre differ: empty iterations of repeats (rewritten
# to sre's), a scan's next match after an empty one (must_advance, A22),
# lastindex and lastgroup (A25), LOCALE with a str pattern (A24)
import re
pats = [r'\1(a)', r'(a\1)', r'(a)\2', r'(?<=\1)(a)', r'(a)(?<=(b)\2)', r'(a)(?<=\1)', r'(?<=(a)\1)', r'(?P=x)(?P<x>a)', r'(?P<x>a(?P=x))',
 r'(?P<x>a)(?<=(?P=x))', r'(?<=(?P<y>a)(?P=y))', r'[\1]', r'[\18]', r'[\8]', r'\777', r'\400', r'[\400]', r'(?<n>a)', r'(?<', r'(?L)a', r'(?iL)a',
 r'(?a)(?u)a', r'(?au)a', r'(?<=a+)b', r'(?<=a|bc)d', r'(?<!a{2})b', r'(?<=a{2})b', r'(?<=(a)\1)b', r'(?i)(?L)a', r'(?i)(?x)\1(a)', r'(?=a)?b', r'(?:)*', r'(?=a)*', r'\b*']
for p in pats:
    try:
        r = re.compile(p)
        print(repr(p), 'OK', r.groups)
    except Exception as e:
        print(repr(p), type(e).__name__, e)
for p, f in [('a', re.L), ('a', re.A | re.U), (b'a', re.L | re.A), (b'(?u)a', 0), (b'(?L)a', 0), ('(?a)a', re.U), (b'a', re.U)]:
    try:
        print(repr(p), int(f), 'OK', re.compile(p, f).flags)
    except Exception as e:
        print(repr(p), int(f), type(e).__name__, e)
print(re.error is re.PatternError, re.PatternError.__name__, re.PatternError.__module__)

pats = ['a*?', 'a*', 'a?', 'x*', '', '(a?)*', '(a?)?', '(?:|a)?', '(a|)*', '(a*)*', '(a*)+', '(a?){2}', '(a?){1,2}', '(a)(?:b)()', '((a))', '(a)()', '()(a)', '(?=(a))(a)', '(a)(?<=(a))', '(a)+', '(?:(a)b)+', '(a)|b', '(a*)*?x', '(a|b)*?c', '(\\b)*', 'x(a?)*y', '(a?)*?b', '(?:a?)*b', '(?P<outer>(?P<inner>a))', '(a)(b)?', '(a)?(b)', '\\b', '\\B', '^', '$', '(?m)^', '(?m)$', '\\w*', '\\w*?', '(?<=a)b*', '(?<=a)b*?', '(?<!a)b*?', '\\b\\w*?', '^a*?', '(?m)^a*?', '(?=a)?a', '(?=(a))*', '(?:\\b)*', '(a)\\1*', '(a)(?:\\1)?', '(a)*', '(?:(a))*', '(a*)+?', '(?:(a?)b)*', '(a?b?)*', '(?:(a?)(b?))*', '(ab|a?)*', '.*?', '(?s).*?', '[^a]*?', '(?:a|b)*?(?=c)', 'a|', '|a', '(?:|a)', '(?:a|)??', '(a|)??', '(a)??', '(a?)??b', '(?i)A*?', '(\\w+)\\s*?', '(?<=\\b)\\w*?', '(?<![a-z])[a-z]*?', '😀*?', '(?:\\U0001f600|)*?']
subs = ['', 'a', 'aa', 'aaa', 'b', 'ab', 'ba', 'abab', 'aab', 'abc', 'xy', 'xay', 'aax', 'bab', 'ac', 'a b', 'AaA', 'a\nb\n', 'xaby', '\U0001f600a\U0001f600']

def show(f):
    try:
        return repr(f())
    except Exception as e:
        return type(e).__name__ + ': ' + str(e)

def mres(m):
    if m is None:
        return None
    return (m.span(), [m.span(g) for g in range(1, m.re.groups + 1)], m.lastindex, m.lastgroup)

for p in pats:
    print('P', repr(p), show(lambda: re.compile(p).groups))
    for s in subs:
        print(' ', repr(s), 'match', show(lambda: mres(re.match(p, s))), 'search', show(lambda: mres(re.search(p, s))),
              'full', show(lambda: mres(re.fullmatch(p, s))))
        print(' ', repr(s), 'findall', show(lambda: re.findall(p, s)), 'sub', show(lambda: re.sub(p, '<\\g<0>>', s)),
              'split', show(lambda: re.split(p, s)), 'iter', show(lambda: [mres(m) for m in re.finditer(p, s)]))

# must_advance with pos and endpos, look-behinds and ^ near the start
for p, s, a in [(r'a*?', 'baab', (1, 3)), (r'(?<=ab)c*?', 'abcabcc', (0, 7)), (r'(?<=a{3})b*?', 'aaabbaaab', (2, 9)), (r'^a*?', 'aa', (0, 2)), (r'(?m)^a*?', 'a\naa', (1, 4)), (r'\b\w*?', 'ab cd', (0, 5))]:
    print(p, s, a, re.compile(p).findall(s, *a), re.sub(p, '-', s), [m.span() for m in re.compile(p).finditer(s, *a)])
print(re.findall('a*?', 'a'), re.sub('a*?', 'X', 'a'), re.split('a*?', 'a'))
print(re.match(r'((a))', 'a').lastindex, re.match(r'(?P<outer>(?P<inner>a))', 'a').lastgroup)
e = re.compile(r'(a)').__class__
try:
    re.compile('a\n(?x)b')
except re.error as x:
    print(type(x).__name__, x, x.msg, x.pos, x.lineno, x.colno, repr(x.pattern))
try:
    re.compile('(\n\n\\9')
except re.PatternError as x:
    print(x, x.pos, x.lineno, x.colno)
# astra's HOLD on 079989b6: zero repetitions are 0 wide, whatever the item
# (CORR-079-1), in a look-behind and in every scan
for p in [r'(?<=(?:a*){0})a', r'(?<=(?:a+){0})a', r'(?<=(a*){0})a', r'(?:a*){0}a*?', r'(a*){0}a*?', r'(?:(?:a*){0})a*?', r'a{0}a*?']:
    print(p, re.findall(p, 'a'), [m.span() for m in re.finditer(p, 'a')], re.sub(p, 'X', 'a'), re.split(p, 'a'))
# error positions in code points, the flags taken off counted (CORR-079-2)
for pattern in ['\U0001f600(', '\U0001f600\\9', '(?i)\U0001f600[', '\U0001f600\n(', '(?x)\U0001f600 \U0001f600 )', '\U0001f600(?<\U0001f600']:
    try:
        re.compile(pattern)
    except re.error as e:
        print(repr(pattern), e.pos, e.lineno, e.colno, str(e))
# a repeat of a part that can match nothing, with a huge minimum: no
# allocation by its count
print(bool(re.compile('(?:a?){1000000000,}')), re.compile('(?:a?b?){4294967294}').groups)
