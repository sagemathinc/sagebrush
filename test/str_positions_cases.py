# str positions count code points, as CPython's (PY-E4A-9): len, indexing,
# slicing, find/index/count, zfill and re's spans on strings with characters
# beyond U+FFFF (astra's 24 cases first), long ones too (past the scan
# cache's threshold), and strings without them, which keep the plain path.
import re
s = 'a\U0001F600b'
t = 'x\U0001F600y\U0001D7DAc\U0001F600'
big = 'a' * 300 + '\U0001F600' * 3 + 'xyz' * 100 + 'z'
bmp = 'a' * 300 + '\u4e2d' * 300 + 'z'
lone = 'a\ud800b\udc00'
CASES = [
    "re.search(r'\\Z', s).span(), re.search(r'\\A.', s).span(), re.fullmatch('a😀b', s).span(), re.fullmatch('a😀', s)",
    "re.findall('(?m)^.', 'a😀\\n😀b\\n'), [m.span() for m in re.finditer('(?m)$', '😀\\nb😀\\n')], re.sub('(?m)^', '>', 'x\\n😀\\n')",
    "[m.span() for m in re.finditer('$', 'b😀\\n')], re.findall('(?m)^$', 'a\\n\\n😀\\n'), re.split('(?m)^', 'a\\nb'), re.search('(?ms)^b.$', 'a\\nb\\n').span()",
    "re.search('x$', 'x\\n').span(), re.search('x$', 'x\\n\\n'), re.search('(?m)x$', 'x\\n\\n').span(), re.search('^x', 'ax'), re.search('(?m)^x', 'a\\nx').span()",
    "'𝟘𝟙𝟚'.rfind('')",
    "'𝟘𝟙𝟚'.count('')",
    "'𝟘𝟙𝟚'.zfill(9)",
    "(len('𝟘𝟙𝟚'), list('𝟘𝟙𝟚'), '𝟘𝟙𝟚'[::-1])",
    "'😀x😀'.rfind('')",
    "'😀x😀'.count('')",
    "'😀x😀'.find('x')",
    "'😀x😀'.rfind('x')",
    "'😀x😀'.rfind('😀')",
    "'😀x😀'.zfill(9)",
    "(len('😀x😀'), list('😀x😀'), '😀x😀'[::-1])",
    "'a😀b'.rfind('')",
    "'a😀b'.count('')",
    "'a😀b'.zfill(9)",
    "(len('a😀b'), list('a😀b'), 'a😀b'[::-1])",
    "'𐐀𐐨'.rfind('')",
    "'𐐀𐐨'.count('')",
    "'𐐀𐐨'.zfill(3)",
    "'𐐀𐐨'.zfill(9)",
    "(len('𐐀𐐨'), list('𐐀𐐨'), '𐐀𐐨'[::-1])",
    "'👩\\u200d🔬'.rfind('')",
    "'👩\\u200d🔬'.count('')",
    "'👩\\u200d🔬'.zfill(9)",
    "(len('👩\\u200d🔬'), list('👩\\u200d🔬'), '👩\\u200d🔬'[::-1])",
    's[0], s[1], s[2], s[-1], s[-2], s[-3]',
    's[1:], s[:2], s[1:2], s[-2:], s[::2], s[::-2], s[2:0:-1], s[5:], s[-9:9]',
    "s.find('b'), s.find('b', 2), s.find('b', -1), s.find('😀', 1, 2), s.find('😀', 2), s.rfind('a'), s.index('b')",
    "s.count('😀'), s.count('', 1), s.count('b', 0, 2), s.startswith('b', 2), s.endswith('😀', 0, 2), s.startswith('😀', -2)",
    "t[0], t[3], t[-1], t[1:4], t[::-1], len(t), t.find('𝟚'), t.find('c', 3), t.rindex('😀')",
    "len(big), big[300], big[-1], big[299:302], big.find('z'), big.rfind('😀'), big.count('😀'), big[::-1][:3]",
    "len(bmp), bmp[300], bmp.find('z'), bmp[::-1][:3], bmp.zfill(605)[:6]",
    "len(lone), lone[1], lone[::-1] == lone[::-1], lone.find('b')",
    "list(reversed(s)), ''.join(reversed(t)), sorted(s)",
    "'{:.2}'.format(s), '%.2s' % s, '{:>5}'.format(s), s.center(7, '*'), s.ljust(5) + '|', f'{s!r:>8}'",
    "s.partition('😀'), s.split('😀'), s.replace('😀', 'X', 1), s.expandtabs(), s.strip('a')",
    "[(m.start(), m.end(), m.span()) for m in re.finditer('b|😀', s)]",
    "re.search('b', s).span(), re.search('b', s, ).group(), re.compile('b').search(s, 2).span(), re.compile('b').search(s, 3)",
    "repr(re.search('b', s)), re.match('a😀', s).end(), re.compile('.').match(s, 1).span(), re.compile('😀').search(t, 2, 5)",
    "re.compile('$').search(s).span(), re.compile('x').search(t, 0, 3), re.compile('.').fullmatch(s, 1, 2).span()",
    "[m.pos for m in re.finditer('.', s, )], re.compile('.').search(s, 1, 2).endpos, re.compile('.').search(s, 1).pos",
    "re.split('😀', t), re.sub('b', '-', s), re.findall('.', s), re.subn('😀', '', t)",
    's[True], s[1:2:1], s[slice(None, None, -1)], s[100:], s[-100:1]',
]
for e in CASES:
    try:
        r = repr(eval(e))
    except Exception as x:
        r = type(x).__name__ + ': ' + str(x)
    print(ascii(e), '->', ascii(r))

# pairs on either side of the index's 32-unit blocks, short and long strings
for k in range(0, 70, 3):
    for tail in ('c' * 10, 'c' * 300):
        s = 'a' * k + '\U0001F600' + 'b' + '\U0001F600' * 40 + 'x\ud800y' + tail
        n = len(s)
        picks = ''.join(s[i] for i in range(n))
        print(k, len(tail), n, picks == s, s[k], s[k + 1], s[-n], s[::-7][:5], s[k:k + 3], s.find('b'), s.rfind('\U0001F600'), s.index('y'), s.count('\U0001F600'), s.find('\U0001F600', k + 2, k + 30))

# matches only on code-point boundaries: never half an astral character (CORR-C4D-2)
s = 'a\U0001F600b'
for h in ('\ud83d', '\ude00'):
    def t(f):
        try:
            return f()
        except Exception as e:
            return type(e).__name__
    print(ord(h), s.find(h), s.rfind(h), s.count(h), t(lambda: s.index(h)), t(lambda: s.rindex(h)), h in s,
          s.split(h), s.rsplit(h), s.partition(h), s.rpartition(h), s.replace(h, 'X'), s.count(h, 1), s.find(h, 1, 2))
print(s.startswith('a\ud83d'), s.endswith('\ude00b'), s.startswith('\ude00', 1), s.removeprefix('a\ud83d'), s.removesuffix('\ude00b'),
      s.startswith(('a\ud83d', 'a')), s.split('\ude00b'), s.count('a\ud83d'), s.replace('a\ud83d', 'Z', 1))
lone = 'x\ud83dy\ude00z\ude00\ud83d'
print(*map(ascii, (lone.find('\ud83d'), lone.rfind('\ud83d'), lone.count('\ude00'), lone.split('\ude00'), lone.replace('\ud83d', '-'), '\ude00' in lone, lone.index('\ude00\ud83d'))))
