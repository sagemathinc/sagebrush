# re's Unicode rules as CPython's (astra's round-2 hunt, PY-1C6-1, -3, -4):
# \b and \w by Unicode word characters, \s by str.isspace(), . all but \n,
# IGNORECASE joining I, i, U+0130 and U+0131, classes with \S \W \D in them,
# scoped flags; and complex arithmetic as CPython 3.14's (PY-1C6-5): Annex G
# products and quotients, and mixed real and complex operands.
import re, math, itertools
CASES = [
    (r'\b\w+\b', 'é', 0), (r'\b\w+\b', 'naïve café ß', 0), (r'\w+', 'Ω₂ x²  ٣', 0), (r'\W+', 'a é,b', 0),
    (r'\bé\B', 'éé', 0), (r'\Bb', 'ab b', 0), (r'\d+', '12٣४', 0), (r'\D+', '1a٣b', 0),
    (r'[A-Z]+', 'İı', re.I), (r'[a-z]+', 'İıIi', re.I), (r'[^a-z]', 'ı', re.I), (r'[i-k]', 'İ', re.I), (r'(?i:I)', 'ı', 0),
    (r'I', 'iİı', re.I), (r'[^I]', 'İ', re.I), (r'ǅ', 'Ǆǆ', re.I), (r'σ', 'Σς', re.I), (r'k', 'K', re.I), (r'ß', 'ẞ', re.I),
    (r'.+', 'abc\r\n', 0), (r'.', '\r\n  \x85', 0), (r'(?s).', 'a\nb', 0), (r'(?s:.)+', 'a\nb', 0), (r'a.c', 'a\nc', re.S),
    (r'\s+', 'a\x1c\x1d\x1e\x1f﻿\x85\xa0　b', 0), (r'\S+', 'a\x1c﻿b', 0), (r'[^\S\n]+', 'a \t\nb　', 0),
    (r'[\W\d]+', 'ab12-!c', 0), (r'[^\W\d]{2}', 'abc_1', 0), (r'[^\S\n]*x', ' \n x', 0), (r'[\S\d]+?', 'a b', 0), (r'[^\W\d]+', 'ab12_c', 0), (r'[\s\d]+', 'a 1\t2b', 0), (r'[^\s\S]', 'abc', 0),
    (r'(?m:^b)', 'a\nb', 0), (r'(?m)^\w+$', 'one\ntwo\n', 0), (r'^\w+$', 'one\ntwo\n', 0), (r'(?i)straße', 'STRASSE straße', 0),
    (rb'\w+', b'\xe9ab', 0), (rb'\s+', b'a\x1c\x85 b', 0), (rb'.+', b'a\rb\n', 0), (r'\w+', 'é1', re.A), (r'\b\w', 'é a', re.A),
]
for p, s, f in CASES:
    try:
        r = re.findall(p, s, f)
    except re.error as e:
        r = 'error: ' + str(e)
    print(ascii(p), ascii(s), int(f), ascii(r))
print(re.sub(r'\b', '|', 'naïve x'), re.split(r'\W+', 'é,ü;ö'), [m.span() for m in re.finditer(r'\b\w+\b', 'αβ γ')])
vals = [0.0, -0.0, 1.0, -2.5, math.inf, -math.inf, math.nan]
cs = [complex(a, b) for a in vals for b in vals]
def show(f):
    try:
        z = f()
    except ZeroDivisionError as e:
        return 'ZeroDivisionError'
    return repr(z)
out = []
for a, b in itertools.product(cs, cs):
    out.append(show(lambda: a * b) + ' ' + show(lambda: a / b))
for c, r in itertools.product(cs, vals):
    out.append(' '.join(show(f) for f in (lambda: c * r, lambda: r * c, lambda: c / r, lambda: r / c, lambda: c + r, lambda: r + c, lambda: c - r, lambda: r - c)))
print(len(out))
for line in out:
    print(line)

# astra's round-2 hunt at 1c6184e8: the 138 confirmed cases (word boundaries,
# astral spans, ., IGNORECASE ranges, non-finite complex products), each in a
# fresh namespace
ROUND2 = [
    ("p=re.compile('(?P<word>\\\\w+)', 0); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('(?P<word>\\\\w+)', 2); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('(?P<word>\\\\w+)', 8); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('(?<!a)b', 0); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('(?<!a)b', 2); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('(?<!a)b', 8); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='İıſK'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='İıſK'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='İıſK'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='İıſK'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='İıſK'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='İıſK'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='İıſK'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='İıſK'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='İıſK'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='αβ١٢'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='αβ١٢'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='αβ١٢'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='αβ١٢'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='αβ١٢'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='αβ١٢'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='αβ١٢'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='αβ١٢'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='αβ١٢'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='é中🙂'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='é中🙂'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='é中🙂'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='é中🙂'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='é中🙂'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='é中🙂'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='  é'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='  é'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='  é'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='  é'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='  é'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='  é'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='  é'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='  é'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='  é'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='21 \\nA éA\\n\\n1'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='21 \\nA éA\\n\\n1'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='21 \\nA éA\\n\\n1'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='21 \\nA éA\\n\\n1'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='21 \\nA éA\\n\\n1'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='21 \\nA éA\\n\\n1'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='21 \\nA éA\\n\\n1'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='21 \\nA éA\\n\\n1'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='21 \\nA éA\\n\\n1'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='éab\\né1'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='éab\\né1'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='éab\\né1'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='éab\\né1'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='éab\\né1'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='éab\\né1'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='éab\\né1'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='éab\\né1'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='éab\\né1'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='é éé'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='é éé'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 0); s='é éé'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='é éé'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='é éé'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 2); s='é éé'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='é éé'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='é éé'", 'p.split(s)'),
    ("p=re.compile('\\\\b\\\\w+\\\\b', 8); s='é éé'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('.+', 0); s='abc\\r\\n'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('.+', 0); s='abc\\r\\n'", 'p.split(s)'),
    ("p=re.compile('.+', 0); s='abc\\r\\n'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('.+', 2); s='abc\\r\\n'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('.+', 2); s='abc\\r\\n'", 'p.split(s)'),
    ("p=re.compile('.+', 2); s='abc\\r\\n'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('.+', 8); s='abc\\r\\n'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('.+', 8); s='abc\\r\\n'", 'p.split(s)'),
    ("p=re.compile('.+', 8); s='abc\\r\\n'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('.+', 0); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('.+', 2); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('.+', 8); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('.+', 0); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('.+', 2); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('.+', 8); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('^a.*$', 0); s='abc\\r\\n'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('^a.*$', 0); s='abc\\r\\n'", 'p.split(s)'),
    ("p=re.compile('^a.*$', 0); s='abc\\r\\n'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('^a.*$', 2); s='abc\\r\\n'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('^a.*$', 2); s='abc\\r\\n'", 'p.split(s)'),
    ("p=re.compile('^a.*$', 2); s='abc\\r\\n'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('^a.*$', 8); s='abc\\r\\n'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('^a.*$', 8); s='abc\\r\\n'", 'p.split(s)'),
    ("p=re.compile('^a.*$', 8); s='abc\\r\\n'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('^a.*$', 0); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('^a.*$', 2); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('^a.*$', 8); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('(a*)', 0); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('(a*)', 2); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('(a*)', 8); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('(a*)', 0); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('(a*)', 2); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('(a*)', 8); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('(a)?(b)?', 0); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('(a)?(b)?', 2); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('(a)?(b)?', 8); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('(a)?(b)?', 0); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('(a)?(b)?', 2); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('(a)?(b)?', 8); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('[A-Z]+', 2); s='İıſK'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('[A-Z]+', 2); s='İıſK'", 'p.split(s)'),
    ("p=re.compile('[A-Z]+', 2); s='İıſK'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('[A-Z]+', 2); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('[^a-z]+', 2); s='İıſK'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('[^a-z]+', 2); s='İıſK'", 'p.split(s)'),
    ("p=re.compile('[^a-z]+', 2); s='İıſK'", 'p.sub(lambda m:"["+m.group(0)+"]",s)'),
    ("p=re.compile('[^a-z]+', 0); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('[^a-z]+', 2); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('[^a-z]+', 8); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('[^a-z]+', 0); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('[^a-z]+', 2); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('[^a-z]+', 8); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\A.*\\\\Z', 0); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\A.*\\\\Z', 2); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\A.*\\\\Z', 8); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\A.*\\\\Z', 0); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\A.*\\\\Z', 2); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\A.*\\\\Z', 8); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\W+', 0); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\W+', 2); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\W+', 8); s='é中🙂'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\W+', 0); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\W+', 2); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ("p=re.compile('\\\\W+', 8); s='a🙂b'", '[(m.group(0),m.groups(),m.groupdict(),m.span()) for m in p.finditer(s)]'),
    ('', "(complex(float('inf'),float('1.0')))*(complex(float('nan'),float('1.0')))"),
    ('', "(complex(float('nan'),float('1.0')))*(complex(float('inf'),float('1.0')))"),
]
for setup, expr in ROUND2:
    ns = {'re': re, 'math': math}
    try:
        exec(setup, ns)
        r = repr(eval(expr, ns))
    except Exception as x:
        r = type(x).__name__ + ': ' + str(x)
    print(ascii(expr), '->', ascii(r))
