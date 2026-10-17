# astra's match-statement review probe (delta_probe.py, c6128a80), compared with CPython 3.14 by test/match.test.ts
from collections.abc import Sequence
import builtins

def show(label, f):
    try: print(label, '->', repr(f()))
    except Exception as e: print(label, 'raises', type(e).__name__, str(e).split('\n')[0])

class Indexed(Sequence):
    def __len__(self): return 3
    def __getitem__(self, i):
        if i < 0: raise RuntimeError('negative index')
        return 100 + i
    def __iter__(self): raise RuntimeError('iterated')
def last(s):
    match s:
        case [*_, x]: return x
show('star-wildcard suffix index', lambda: last(Indexed()))

class Skip(Indexed):
    def __getitem__(self, i):
        if i == 0: raise RuntimeError('wildcard item fetched')
        return 100 + i
def skip(s):
    match s:
        case [_, *_, x]: return x
show('skip wildcard index', lambda: skip(Skip()))

class RaisingTail(Sequence):
    def __len__(self): return 2
    def __getitem__(self, i): raise RuntimeError('indexed')
    def __iter__(self):
        yield 1
        yield 2
        yield 3
        raise RuntimeError('unpack consumed past overflow')
def fixed(s):
    match s:
        case [a,b]: return a,b
show('fixed iterator overflow', lambda: fixed(RaisingTail()))

subject = [1,2,3]
class Mutator:
    def __eq__(self, other):
        subject[-1] = 99
        return True
class Values:
    first = Mutator()
def staged():
    match subject:
        case [Values.first, *_, tail]: return tail
show('wildcard star staged values', staged)

# Literal folding must convert the real part to double in a complex literal.
for pat in ['{9007199254740993+0j:a, 9007199254740992:b}',
            '{9007199254740993+0j:a, 9007199254740993:b}',
            '{-9007199254740993+0j:a, -9007199254740992:b}',
            '{9007199254740993+1j:a, 9007199254740992+1j:b}']:
    source='match {}:\n case '+pat+': pass\n'
    def comp():
        compile(source, '<case>', 'exec')
        return 'accepted'
    show('compile '+pat, comp)

class mappingproxy:
    def __len__(self): return 0

def empty_map(s):
    match s:
        case {}: return True
        case _: return False
show('fake mappingproxy type', lambda: empty_map(mappingproxy()))
FakeList = type('list', (), {'__module__':'builtins', '__len__':lambda s:0})
def empty_seq(s):
    match s:
        case []: return True
        case _: return False
show('fake builtins.list type', lambda: empty_seq(FakeList()))

class C: pass
obj=C()
def class_match():
    match obj:
        case C(): return True
        case _: return False
old_isinstance=builtins.isinstance
builtins.isinstance=lambda *args: False
try:
    result=class_match()
finally:
    builtins.isinstance=old_isinstance
show('class match after isinstance replaced', lambda: result)

# Warm the ABC cache before replacing the public builtin.
Sequence.register(Indexed)
empty_seq(Indexed())
old_issubclass=builtins.issubclass
builtins.issubclass=lambda *args: False
try:
    result=last(Indexed())
finally:
    builtins.issubclass=old_issubclass
show('sequence after issubclass replaced', lambda: result)

class Args(tuple): pass
class ClassArgs:
    __match_args__ = Args(('x',))
    x=1
def tuple_subclass_args():
    match ClassArgs():
        case ClassArgs(v): return v
show('tuple subclass match args', tuple_subclass_args)
