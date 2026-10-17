# C-boundary payloads and argument conversions of time and datetime (S2;
# astra's CORR-DCB-2..4 and CORR-A7A-1..3 repros first, then more): a float,
# int, str or tuple subclass's own value is read, its methods unused; each
# integer argument converted once, in CPython's order; replace()'s and
# combine()'s None and True are values. Compared with CPython 3.14.
import time, datetime as D

def show(label, f):
    try: print(label, '->', repr(f()))
    except Exception as e: print(label, 'raises', type(e).__name__, str(e))

base = (2020,1,2,3,4,5,3,2,0)
class F(float):
    def __ne__(self, other): raise RuntimeError('float __ne__ used')
    def __lt__(self, other): raise RuntimeError('float __lt__ used')
    def __ge__(self, other): raise RuntimeError('float __ge__ used')
    def __floor__(self): raise RuntimeError('float __floor__ used')
    def __float__(self): raise RuntimeError('float __float__ used')
class T(tuple):
    def __iter__(self): raise RuntimeError('tuple __iter__ used')
class L(tuple):
    def __len__(self): raise RuntimeError('tuple __len__ used')
class S(str):
    def __len__(self): raise RuntimeError('str __len__ used')
    def __getitem__(self, key): raise RuntimeError('str __getitem__ used')
class I:
    def __init__(self, value): self.value=value
    def __index__(self): return self.value
for name, func in [('gmtime',time.gmtime),('localtime',time.localtime),('ctime',time.ctime)]:
    show(name+' float subclass', lambda: func(F(1.5)))
for name, func in [('asctime',time.asctime),('mktime',time.mktime),('strftime',lambda t:time.strftime('%Y-%m-%d',t))]:
    show(name+' tuple iter',lambda:func(T(base)))
    show(name+' tuple len',lambda:func(L(base)))
show('time format subclass',lambda:time.strftime(S('%Y-%m-%d'),base))
show('time format NUL',lambda:time.strftime('%Y\0%m',base))
for zone,off in [(123,0),('Z',2**100),('Z',1.5)]:
    t=time.struct_time(base,{'tm_zone':zone,'tm_gmtoff':off})
    show('asctime extras '+repr((zone,off)),lambda:time.asctime(t))
show('strftime weekday C overflow',lambda:time.strftime('%w',base[:6]+(2**31-1,2,0)))
show('date ordinal index',lambda:D.date.fromordinal(I(737425)))
show('datetime ordinal index',lambda:D.datetime.fromordinal(I(737425)))
show('date isocalendar index',lambda:D.date.fromisocalendar(I(2020),I(1),I(1)))
show('datetime isocalendar index',lambda:D.datetime.fromisocalendar(I(2020),I(1),I(1)))
show('combine explicit True',lambda:D.datetime.combine(D.date(2020,1,1),D.time(2),True))
show('time replace explicit True',lambda:D.time(2).replace(tzinfo=True))
show('datetime replace explicit True',lambda:D.datetime(2020,1,1).replace(tzinfo=True))
show('timezone subclass',lambda:type('Zone',(D.timezone,),{}).__name__)
show('date ISO str subclass',lambda:D.date.fromisoformat(S('2020-01-02')))
show('datetime ISO str subclass',lambda:D.datetime.fromisoformat(S('2020-01-02T03:04:05')))
show('time ISO str subclass',lambda:D.time.fromisoformat(S('03:04:05')))
show('datetime timestamp float subclass',lambda:D.datetime.fromtimestamp(F(1.5),D.timezone.utc))
show('date strftime NUL',lambda:D.date(2020,1,2).strftime('%Y\0%m'))
show('datetime ISO unicode sep',lambda:D.datetime(2020,1,2).isoformat('😀'))
show('date replace explicit None',lambda:D.date(2020,1,1).replace(year=None))
show('time replace explicit None',lambda:D.time(2).replace(hour=None))
show('datetime replace explicit None',lambda:D.datetime(2020,1,1).replace(year=None))
class TupleIter(tuple):
    def __iter__(self): return iter([99])
show('tuple subclass constructor iteration',lambda:tuple(TupleIter((1,2))))

# ---- more: side effects counted, the conversions' limits
calls = []
class J:
    def __init__(self, value, tag): self.value, self.tag = value, tag
    def __index__(self):
        calls.append(self.tag)
        return self.value
def counted(label, f):
    del calls[:]
    show(label, f)
    print('  __index__ calls', calls)
counted('fromordinal once', lambda: D.date.fromordinal(J(737425, 'n')))
counted('fromisocalendar order', lambda: D.date.fromisocalendar(J(2020, 'y'), J(1, 'w'), J(1, 'd')))
counted('fromisocalendar keywords', lambda: D.datetime.fromisocalendar(day=J(1, 'd'), week=J(1, 'w'), year=J(2020, 'y')))
counted('date fields', lambda: D.date(J(2020, 'y'), J(1, 'm'), J(2, 'd')))
counted('time fields', lambda: D.time(J(1, 'h'), J(2, 'm'), J(3, 's'), J(4, 'u'), fold=J(1, 'f')))
counted('gmtime index', lambda: time.gmtime(J(5, 't')))
counted('struct fields', lambda: time.asctime((J(2020, 'y'), 1, 2, 3, 4, 5, 3, 2, J(0, 'i'))))
class IntSub(int):
    def __index__(self): raise RuntimeError('int __index__ used')
    def __int__(self): raise RuntimeError('int __int__ used')
    def __float__(self): raise RuntimeError('int __float__ used')
    def __lt__(self, other): raise RuntimeError('int __lt__ used')
    def __le__(self, other): raise RuntimeError('int __le__ used')
    def __gt__(self, other): raise RuntimeError('int __gt__ used')
    def __ge__(self, other): raise RuntimeError('int __ge__ used')
    def __add__(self, other): raise RuntimeError('int __add__ used')
    def __radd__(self, other): raise RuntimeError('int __radd__ used')
    def __sub__(self, other): raise RuntimeError('int __sub__ used')
    def __rsub__(self, other): raise RuntimeError('int __rsub__ used')
show('gmtime int subclass', lambda: time.gmtime(IntSub(5)))
show('struct int subclass', lambda: time.asctime((IntSub(2020), 1, 2, 3, 4, 5, 3, 2, 0)))
show('fromtimestamp int subclass', lambda: D.datetime.fromtimestamp(IntSub(5), D.timezone.utc))
show('date.fromtimestamp float subclass', lambda: D.date.fromtimestamp(F(86400.5)))
show('fromordinal int subclass', lambda: D.date.fromordinal(IntSub(737425)))
show('date int subclass', lambda: D.date(IntSub(2020), 1, 2))
show('sleep float subclass', lambda: time.sleep(F(0.0)))
show('sleep int subclass', lambda: time.sleep(IntSub(0)))
class G(float):
    pass
show('gmtime plain float subclass', lambda: time.gmtime(G(2.5)))
show('localtime plain float subclass', lambda: tuple(time.localtime(G(2.5))))
for z in [123, 'Z', 'a\0b', None, b'Z', G(1.0)]:
    show('zone %r' % (z,), lambda: time.asctime(time.struct_time(base, {'tm_zone': z, 'tm_gmtoff': 0})))
# (a lone surrogate: the exception's type; its message is the runtime's)
try:
    time.asctime(time.struct_time(base, {'tm_zone': 'a\ud800', 'tm_gmtoff': 0}))
except Exception as e:
    print('zone surrogate raises', type(e).__name__)
for g in [2**100, 2**63, 2**63 - 1, -2**63, -2**63 - 1, 1.5, '3', True, None, I(7), IntSub(7)]:
    label = repr(g) if type(g) in (int, float, str, bool, type(None)) else '%s(7)' % type(g).__name__
    show('gmtoff ' + label, lambda: time.asctime(time.struct_time(base, {'tm_zone': 'Z', 'tm_gmtoff': g})))
show('zone and gmtoff both bad', lambda: time.asctime(time.struct_time(base, {'tm_zone': 1, 'tm_gmtoff': 2**100})))
show('field before zone', lambda: time.asctime(time.struct_time(base[:3] + (2**40,) + base[4:], {'tm_zone': 1})))
show('zone mktime', lambda: time.mktime(time.struct_time(base, {'tm_zone': 123})))
show('zone strftime', lambda: time.strftime('%Y', time.struct_time(base, {'tm_zone': 123})))
show('zone %Z', lambda: time.strftime('%Z', time.struct_time(base, {'tm_zone': 'ABC'})))
show('zone %Z subclass', lambda: time.strftime('%Z', time.struct_time(base, {'tm_zone': S('ABC')})))
for w in [2**31 - 1, 2**31 - 2, -2**31, -2, -1, -8, -9, 6, 7, 13, -14, -15]:
    show('wday %d' % w, lambda: time.strftime('%w %a', base[:6] + (w, 2, 0)))
    show('asctime wday %d' % w, lambda: time.asctime(base[:6] + (w, 2, 0)))
    show('mktime wday %d' % w, lambda: time.mktime(base[:6] + (w, 2, 0)))
for v in [0, -1, 2**31 - 1, 2**31, -2**31 - 1, 2**63, 2**64]:
    show('fromordinal %d' % v, lambda: D.date.fromordinal(v))
for a in [(2**31, 1, 1), (2020, 2**31, 1), (2020, 1, 2**64), (-2**31 - 1, 1, 1), (10000, 1, 1), (2020, 54, 1), (2020, 1, 8)]:
    show('fromisocalendar %r' % (a,), lambda: D.date.fromisocalendar(*a))
show('fromisocalendar None', lambda: D.date.fromisocalendar(None, 1, 1))
for a in [(2**31, 1, 1), (2**64, 1, 1), (2020, -2**31 - 1, 1), (2020, 1, 2**63)]:
    show('date %r' % (a,), lambda: D.date(*a))
show('time hour 2**31', lambda: D.time(2**31))
show('time fold 2**64', lambda: D.time(1, fold=2**64))
for label, f in [
        ('date replace month None', lambda: D.date(2020, 1, 1).replace(month=None)),
        ('date replace day None', lambda: D.date(2020, 1, 1).replace(day=None)),
        ('date __replace__ None', lambda: D.date(2020, 1, 1).__replace__(year=None)),
        ('date replace nothing', lambda: D.date(2020, 1, 1).replace()),
        ('time replace fold None', lambda: D.time(2).replace(fold=None)),
        ('time replace fold 2', lambda: D.time(2).replace(fold=2)),
        ('time replace minute None', lambda: D.time(2).replace(minute=None)),
        ('time replace tzinfo None', lambda: D.time(2, tzinfo=D.timezone.utc).replace(tzinfo=None)),
        ('time replace nothing', lambda: D.time(2, tzinfo=D.timezone.utc).replace()),
        ('time __replace__ True', lambda: D.time(2).__replace__(tzinfo=True)),
        ('datetime replace fold None', lambda: D.datetime(2020, 1, 1).replace(fold=None)),
        ('datetime replace microsecond None', lambda: D.datetime(2020, 1, 1).replace(microsecond=None)),
        ('datetime replace tzinfo None', lambda: D.datetime(2020, 1, 1, tzinfo=D.timezone.utc).replace(tzinfo=None)),
        ('datetime replace nothing', lambda: D.datetime(2020, 1, 1, tzinfo=D.timezone.utc).replace()),
        ('datetime __replace__ True', lambda: D.datetime(2020, 1, 1).__replace__(tzinfo=True)),
        ('datetime __replace__ None', lambda: D.datetime(2020, 1, 1).__replace__(hour=None)),
        ('combine None', lambda: D.datetime.combine(D.date(2020, 1, 1), D.time(2, tzinfo=D.timezone.utc), None)),
        ('combine omitted', lambda: D.datetime.combine(D.date(2020, 1, 1), D.time(2, tzinfo=D.timezone.utc))),
        ('combine keyword', lambda: D.datetime.combine(D.date(2020, 1, 1), D.time(2), tzinfo=D.timezone.utc)),
        ('combine keyword True', lambda: D.datetime.combine(D.date(2020, 1, 1), D.time(2), tzinfo=True)),
]:
    show(label, f)
class R(str):
    def __repr__(self): return 'R-repr'
    def __len__(self): raise RuntimeError('str __len__ used')
show('date ISO bad subclass', lambda: D.date.fromisoformat(R('2020-0x-02')))
show('datetime ISO bad subclass', lambda: D.datetime.fromisoformat(R('2020-01-0xT03')))
show('time ISO bad subclass', lambda: D.time.fromisoformat(R('T0x:04')))
show('time ISO bad T', lambda: D.time.fromisoformat('Tx'))
show('time ISO T subclass', lambda: D.time.fromisoformat(S('T03:04:05')))
show('date strftime subclass', lambda: D.date(2020, 1, 2).strftime(S('%Y-%m')))
show('datetime strftime subclass', lambda: D.datetime(2020, 1, 2, 3).strftime(S('%Y %H %z')))
show('date format subclass', lambda: format(D.date(2020, 1, 2), S('%d')))
show('time strftime %Z subclass', lambda: time.strftime(S('%Y %%'), base))
show('fromtimestamp index', lambda: D.datetime.fromtimestamp(I(86400), D.timezone.utc))
show('fromtimestamp str', lambda: D.datetime.fromtimestamp('1', D.timezone.utc))
class TL(list):
    def __iter__(self): return iter([7])
show('tuple list subclass iter', lambda: tuple(TL([1, 2])))
t0 = (1, 2, 3)
show('tuple exact identity', lambda: tuple(t0) is t0)
class TP(tuple):
    pass
tp = TP((1, 2))
show('tuple subclass copy', lambda: (tuple(tp), type(tuple(tp)).__name__, tuple(tp) is tp))
show('list of tuple subclass iter', lambda: list(TupleIter((1, 2))))

# ---- datetime's constructors: every integer argument converted, in order, before any check (astra's note on 6f3746ea)
calls = []
class C:
    def __init__(s, v, t): s.v, s.t = v, t
    def __index__(s):
        calls.append(s.t)
        if s.v is None: raise TypeError('bad ' + s.t)
        return s.v
def t2(label, f):
    del calls[:]
    try: r = repr(f())
    except Exception as e: r = '%s: %s' % (type(e).__name__, e)
    print(label, '->', r, calls)
t2('dt month 13, hour index', lambda: D.datetime(2020, 13, 1, C(1, 'h')))
t2('dt month 13, bad hour', lambda: D.datetime(2020, 13, 1, C(None, 'h')))
t2('dt bad fold, month 13', lambda: D.datetime(2020, 13, 1, fold=C(None, 'f')))
t2('dt all index', lambda: D.datetime(C(2020,'y'), C(1,'m'), C(2,'d'), C(3,'h'), C(4,'mi'), C(5,'s'), C(6,'us'), fold=C(0,'f')))
t2('dt hour 24 then bad tz', lambda: D.datetime(2020, 1, 1, 24, tzinfo=1))
t2('dt bad tz, month 13', lambda: D.datetime(2020, 13, 1, tzinfo=1))
t2('dt month 13, hour 2**31', lambda: D.datetime(2020, 13, 1, 2**31))
t2('dt fold 2, hour 24', lambda: D.datetime(2020, 1, 1, 24, fold=2))
t2('time hour 24, bad tz', lambda: D.time(24, tzinfo=1))
t2('time fold bad, hour 24', lambda: D.time(24, fold=C(None, 'f')))
t2('time all index', lambda: D.time(C(1,'h'), C(2,'m'), C(3,'s'), C(4,'u'), fold=C(1,'f')))
t2('time fold 2 hour 24', lambda: D.time(24, fold=2))
t2('date month 13 bad day', lambda: D.date(2020, 13, C(None, 'd')))
