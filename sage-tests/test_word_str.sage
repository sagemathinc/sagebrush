# str(w) of a word is its letters alone, repr(w) is "word: ..." (print(w) and '%s' % w give the letters), as Sage
# (friction W24)
def show(label, f):
    try:
        print(label, '|', f())
    except Exception as e:
        print(label, '| ERR', type(e).__name__, repr(str(e)[:120]))
w = Word('kitten')
print(str(w)); print(repr(w)); print(w)
for n, f in [('str(Word list)', lambda: str(Word([1, 2, 3]))), ('repr(Word list)', lambda: repr(Word([1, 2, 3]))), ('str(Word empty)', lambda: str(Word(''))), ('repr(Word empty)', lambda: repr(Word(''))),
             ('format Word', lambda: '%s' % Word('abc')), ('format Word r', lambda: '%r' % Word('abc')), ('str(Word([10,2]))', lambda: str(Word([10, 2]))), ("str(Word(['ab','c']))", lambda: str(Word(['ab', 'c']))),
             ('repr(Word([10,2]))', lambda: repr(Word([10, 2]))), ('str(Word((1,2)))', lambda: str(Word((1, 2)))), ('list of words', lambda: [Word('ab'), Word([1])]), ('str list of words', lambda: str([Word('ab')]))]:
    show(n, f)
