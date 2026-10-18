# The sign of a zero in RealField(p), as Sage (MPFR's -0): R(-0.0) and
# R('-0') are -0, the sign of a product or quotient is the product of the
# signs, two zeros add to their common sign (else +0, -0 rounding down),
# -0 to an odd power keeps its sign (-0^-3 is -infinity), a zero remainder
# has the sign of x, an underflow keeps its sign, and -0 prints, converts
# (float, RR, other fields) and is the odd functions' value at -0.
def show(label, f):
    try:
        r = f()
        # (an integer's type is left out: a Python int is sagebrush's
        # Integer)
        intlike = isinstance(r, (bool, int)) or type(r).__name__ == "Integer"
        p = "" if intlike else r.parent() if hasattr(r, 'parent') else type(r).__name__
        print(label, "->", repr(r), p) if p != "" else print(label, "->", repr(r))
    except Exception as e:
        print(label, "!!", type(e).__name__, str(e)[:120])
for nm, R in [("RR", RR), ("R30", RealField(30)), ("R100", RealField(100))]:
    z, n, o = R(-0.0), R(0), R(1)
    inf = R('inf')
    rows = [
        ("R(-0.0)", lambda: R(-0.0)), ("R('-0')", lambda: R('-0')), ("-R(0)", lambda: -n), ("R(0)*-1", lambda: n * -1),
        ("R(-0)*5", lambda: z * R(5)), ("R(0)*-5", lambda: n * R(-5)), ("-0*-5", lambda: z * R(-5)), ("-0*0", lambda: z * n),
        ("-0+-0", lambda: z + z), ("-0+0", lambda: z + n), ("0+-0", lambda: n + z), ("-0-0", lambda: z - n), ("0-0", lambda: n - n),
        ("-0--0", lambda: z - z), ("x-x", lambda: R(3) - R(3)), ("-x+x", lambda: R(-3) + R(3)), ("-0+3", lambda: z + R(3)),
        ("0/-5", lambda: n / R(-5)), ("-0/5", lambda: z / R(5)), ("-0/-5", lambda: z / R(-5)), ("1/-0", lambda: o / z), ("-1/-0", lambda: -o / z),
        ("1/-inf", lambda: o / -inf), ("-5/inf", lambda: R(-5) / inf), ("1/R(-0)", lambda: 1 / z),
        ("-0^2", lambda: z ^ 2), ("-0^3", lambda: z ^ 3), ("-0^-2", lambda: z ^ -2), ("-0^-3", lambda: z ^ -3), ("-0^0", lambda: z ^ 0),
        ("-inf^-3", lambda: (-inf) ^ -3), ("-inf^-2", lambda: (-inf) ^ -2), ("-0^R(3)", lambda: z ^ R(3)), ("-0^R(2)", lambda: z ^ R(2)),
        ("-0^R(-3)", lambda: z ^ R(-3)), ("-0^R(0.5)", lambda: z ^ R(0.5)), ("-0^R(-0.5)", lambda: z ^ R(-0.5)), ("-inf^R(-3)", lambda: (-inf) ^ R(-3)),
        ("R(-2)^(-2^70)", lambda: R(-2) ^ (-2 ^ 70)), ("R(-2)^(-2^70-1)", lambda: R(-2) ^ (-2 ^ 70 - 1)),
        ("-0%3", lambda: z % R(3)), ("-3%3", lambda: R(-3) % R(3)), ("3%-3", lambda: R(3) % R(-3)), ("-6%4", lambda: R(-6) % R(4)),
        ("sqrt(-0)", lambda: z.sqrt()), ("abs(-0)", lambda: abs(z)), ("sin(-0)", lambda: z.sin()), ("tan(-0)", lambda: z.tan()),
        ("atan(-0)", lambda: z.arctan()), ("asin(-0)", lambda: z.arcsin()), ("sinh(-0)", lambda: z.sinh()), ("tanh(-0)", lambda: z.tanh()),
         ("exp(-0)", lambda: z.exp()), ("cos(-0)", lambda: z.cos()), ("log(-0)", lambda: z.log()),
        ("float(-0)", lambda: float(z)), ("str(-0)", lambda: str(z)), ("sign(-0)", lambda: z.sign()), ("is_zero", lambda: z.is_zero()),
        ("==0", lambda: z == 0), ("hash", lambda: hash(z) == hash(n)), ("sme", lambda: z.sign_mantissa_exponent()),
        ("RR(R(-0))", lambda: RR(z)), ("R100(R(-0))", lambda: RealField(100)(z)), ("R30(R(-0))", lambda: RealField(30)(z)),
        ("QQ(-0)", lambda: QQ(z)), ("ZZ(-0)", lambda: ZZ(z)), ("int(-0)", lambda: int(z)), ("-0<0", lambda: z < n), ("-0.floor", lambda: z.floor()),
        ("R(-0.5).round", lambda: R(-0.5).round()), ("R(-0.4).trunc", lambda: R(-0.4).trunc()), ("-0*inf", lambda: z * inf),
        ("-0+R(-1e-300)", lambda: z + R(-1e-300)), ("R(-1e-300)*1e-300", lambda: R(-1e-300) * R(1e-300)),
        ("-0.nan", lambda: z.is_NaN()), ("sqrt(-0)^2", lambda: z.sqrt() ^ 2), ("-(-0)", lambda: -z), ("-0*QQ(3)", lambda: z * QQ(3)),
        ("-0*2", lambda: z * 2), ("-0+QQ(0)", lambda: z + QQ(0)), ("-0-QQ(0)", lambda: z - QQ(0)), ("2*-0", lambda: 2 * z),
        ("-0/QQ(2)", lambda: z / QQ(2)), ("QQ(1)/-0", lambda: QQ(1) / z),
    ]
    for lab, f in rows:
        if nm == "RR" and lab in ("sme", "R(-0.4).trunc", "-0.nan"):
            continue
        show("%s %s" % (nm, lab), f)
# exact cancellation and two zeros by rounding mode: -0 rounding down
for rnd in ["RNDN", "RNDZ", "RNDU", "RNDD"]:
    R = RealField(30, rnd=rnd)
    z, n = R(-0.0), R(0)
    for lab, f in [("3-3", lambda: R(3) - R(3)), ("-3+3", lambda: R(-3) + R(3)), ("-0+0", lambda: z + n), ("0+-0", lambda: n + z),
                   ("-0-(-0)", lambda: z - z), ("-0+-0", lambda: z + z), ("0-0", lambda: n - n), ("-0*1", lambda: z * R(1)),
                   ("R(-1e-300)/2^(2^62)", lambda: R(-1e-300) / R(2) ^ (2 ^ 62))]:
        show("%s %s" % (rnd, lab), f)
# shifts as Sage's: an integral count with |n| <= 2^63 - 1 (else
# OverflowError; a fractional count TypeError), a zero keeping its sign;
# frac() of an integer, a zero or an infinity a signed zero; "-0" in other
# bases (reciprocals show the zero's sign)
for nm, R in [("R30", RealField(30)), ("R100", RealField(100))]:
    for v in ["0", "-0", "3", "-3", "inf", "-inf", "nan"]:
        x = R(v)
        for n in [0, 1, 2, -2, 2^62, 2^63 - 1, 2^63, 2^64, -2^63, -2^63 - 1, -2^64, 1.5, RR(2), QQ(2), 1/2]:
            show("%s(%s)<<%s" % (nm, v, n), lambda: x << n)
            show("%s(%s)>>%s" % (nm, v, n), lambda: x >> n)
            if v in ("0", "-0") and n in (0, 2, -2):
                show("1/(%s(%s)<<%s)" % (nm, v, n), lambda: 1 / (x << n))
                show("1/(%s(%s)>>%s)" % (nm, v, n), lambda: 1 / (x >> n))
    for v in ["0", "-0", "-3", "3", "-0.5", "0.5", "-2.75", "inf", "-inf", "nan", "-1e-300"]:
        show("%s(%s).frac()" % (nm, v), lambda: R(v).frac())
        show("1/%s(%s).frac()" % (nm, v), lambda: 1 / R(v).frac())
    for b in [2, 3, 8, 16, 36]:
        for s in ["-0", "-0.00", "0", "+0", "-0.0", "-1", "-0.1"]:
            show("%s(%r,base=%d)" % (nm, s, b), lambda: R(s, base=b))
            show("1/%s(%r,base=%d)" % (nm, s, b), lambda: 1 / R(s, base=b))

# shift counts as Sage converts them (astra's probes, hook calls logged):
# an int's value (no hook), a float's int() refused unless equal, an
# integral real or rational, an integer str or bytes; no ratio hook; else
# TypeError.  (Python's Fraction is left out: QQ is a Fraction here.)
calls=[]
class F(float):
 def as_integer_ratio(self):
  calls.append('ratio');return (int(3),int(1))
class Rat:
 def as_integer_ratio(self):
  calls.append('ratio');return (int(2),int(1))
def show_hook(label, fn):
 calls.clear()
 try: print(label, '=>',repr(fn()),calls)
 except Exception as e:print(label,'!!',type(e).__name__,str(e),calls)
for p in [30,100]:
 R=RealField(p)
 for lab,n in [('str-decimal','2.0'),('str-exponent','2e0'),('str-rational','4/2'),('ratio-object',Rat()),('float-ratio',F(2)),('bytes',b'2'),('str-integer','2'),('float-nan',float('nan'))]:
  show_hook((p,lab,'left'),lambda:R(1)<<n)
  show_hook((p,lab,'right'),lambda:R(1)>>n)

import math
from fractions import Fraction
calls=[]
class Ix:
 def __index__(self):
  calls.append('index');return int(2)
class It:
 def __int__(self):
  calls.append('int');return int(2)
class Rat:
 def as_integer_ratio(self):
  calls.append('ratio');return (int(2),int(1))
class FF(float):
 def __int__(self):
  calls.append('float-int');return int(4)
 def as_integer_ratio(self):
  calls.append('float-ratio');return (int(3),int(1))
class II(int):
 def __int__(self):
  calls.append('int-int');return int(3)
vals=[('int',int(2)),('bool',True),('float',float(2)),('fractionfloat',float(2.5)),('floatinf',float('inf')),('floatnan',float('nan')),('rr',RR(2)),('rrfrac',RR(2.5)),('r30',RealField(30)(2)),('r100',RealField(100)(2)),('qq',QQ(2)),('qqfrac',QQ(3)/2),('str','2'),('strdec','2.0'),('strexp','2e0'),('strfrac','4/2'),('bytes',b'2'),('bytearray',bytearray(b'2')),('complex',complex(2,0)),('CC',CC(2)),('ix',Ix()),('it',It()),('ratio',Rat()),('ff',FF(2)),('ii',II(2))]
for p in [30,100]:
 R=RealField(p)
 for s in ['0','-0','1','-3','+inf','-inf','NaN']:
  for label,n in vals:
   for op in ['<<','>>']:
    calls.clear()
    try:
     x=R(s)<<n if op=='<<' else R(s)>>n
     out=repr(x)
    except Exception as e:out=type(e).__name__+': '+str(e)
    print(p,s,label,op,out,calls)

# shift counts given as text: str and bytes subclasses by their native
# text (no __int__/__str__/__bytes__ hook), Sage's integer text rules
# (whitespace, sign, underscores, 0x/0o/0b, ASCII digits); float counts
# compared with == (astra's probes and a text grid)
log=[]
class S(str): pass
class B(bytes): pass
class HS(str):
    def __int__(self): log.append('int'); return int(7)
    def __str__(self): log.append('str'); return '9'
class HB(bytes):
    def __int__(self): log.append('int'); return int(7)
    def __bytes__(self): log.append('bytes'); return b'9'
for prec in [30,100]:
    R=RealField(prec)
    for name,v in [('str',S('2')),('bytes',B(b'2')),('strhooks',HS('2')),('byteshooks',HB(b'2')),('strbad',HS('x')),('bytesbad',HB(b'x'))]:
        for op in ['<<','>>']:
            log[:]=[]
            try: r=R(1)<<v if op=='<<' else R(1)>>v; out=str(r)
            except Exception as e: out=type(e).__name__+': '+str(e)
            print(prec,name,op,out,log)

log=[]
class EQ(float):
    def __eq__(self,o): log.append('eq'); return False
    def __ne__(self,o): log.append('ne'); return False
class FI(float):
    def __int__(self): log.append('int'); return int(2)
    def __float__(self): log.append('float'); return float(5)
    def __eq__(self,o): log.append('eq'); raise RuntimeError('eq called')
    def __ne__(self,o): log.append('ne'); raise RuntimeError('ne called')
class FM(float):
    def __int__(self): log.append('int'); return int(2)**100
class S(str): pass
class B(bytes): pass
class SI(str):
    def __int__(self): log.append('str-int'); return int(2)
class BI(bytes):
    def __int__(self): log.append('bytes-int'); return int(2)
class II(int):
    def __int__(self): log.append('int-int'); raise RuntimeError('int called')
    def __index__(self): log.append('int-index'); raise RuntimeError('index called')
    def __abs__(self): log.append('int-abs'); return int(0)
def show(label,f):
    log[:]=[]
    try: v=f(); result=str(v)
    except Exception as e: result=type(e).__name__+': '+str(e)
    print(label,'=>',result,log)
counts=[('eq2',EQ(2)),('eq2.5',EQ(2.5)),('fi2',FI(2)),('fi2.5',FI(2.5)),('fm2',FM(2)),('strsub',S('2')),('bytessub',B(b'2')),('si',SI('x')),('bi',BI(b'x')),('ii',II(2)),('iiwide',II(int(2)**63)),('floatmax',float(int(2)**63)),('floatin',float(int(2)**63-int(1024))),('rational',QQ(2)),('real',RealField(100)(2))]
for prec in [30,100]:
    R=RealField(prec)
    for name,n in counts:
        show('%s %s left'%(prec,name),lambda:R(1)<<n)
        show('%s %s right'%(prec,name),lambda:R(1)>>n)
    for text in ['  +2  ','02','2_0','\u0662','0x2','-0']:
        show('%s text %r'%(prec,text),lambda:R('-0')>>text)

R = RealField(30)
for t in ['  +2  ', '02', '010', '2_0', '0x10', '0o10', '0b10', '0X1F', '-3', '+ 2', '1e2', '٢', '', ' ', '0x', '2__0', '_2', '2_', 'ff', '00', '-0x3', '0_8', '\t5\n', '0b', '12345678901234567890', b'0x10', b'010', b'2_0', b' 2 ', b'\xd9\xa2']:
    try:
        r = R(1) << t
        print(repr(t), '->', r)
    except Exception as e:
        print(repr(t), '!!', type(e).__name__, str(e)[:80])

# shift-count text: Sage's integer text grammar (underscores and ASCII
# whitespace among the digits ignored; a 0x/0o/0b prefix only after
# spaces, underscores and a sign; non-ASCII whitespace refused), read in
# one pass: very long padding is read, a very long count is refused as
# out of range without forming it (long rows print the result or the
# error's type: Sage names the whole number)
R = RealField(30)
cases = [' 0x2', '0x2 ', '\t0x2', '0x2\t', '\n0x2', '0x 2', '0x_2', '-0x2', '- 0x2', ' -0x2', ' - 0x2', '-\t0x2', ' 0b1', ' 0o7', '\t0o7', ' 010', '\t010', '\n2', ' 2', '2 ', '\t2', '2\t', '\t-2', '\x0b2', '\x0c2', '\r2', '2\r', ' 2', ' 2', '2 ', ' + 2', '+ 0x2', '+\t2', '-\t2', '_0x2', '0_x2', '0x2_', '0X2', ' 0X2', ' 0x2 ', '\t5\n', '\t5', '5\n', '\n5', ' \t5', '\t 5', '0x\t2', ' _2', '_ 2', '2 _', ' 0b_1', '0b1 ', b'\t0x2', b' 0x2', b'\t5', b'0x2 ']
for s in cases:
    try:
        print(repr(s), '->', R(1) << s)
    except Exception as e:
        print(repr(s), '!!', type(e).__name__, str(e)[:60])

R = RealField(30)
cases = ['1 2', '1\t2', '0x1 2', '0x1\t2', ' 0x\t2', '0 x2', '\t+0x2', ' +0x2', '\t 0x2', ' \t0x2', '+ \t0x2', '_\t0x2', '\t_0x2', '-  0x2', '  0x2', '0x2\n', '\t5 6', '5\t\t', '\f0x2', '\v0x2', '\r0x2', ' \n0x2', '0b1 0', '10\n0', '+-2', '--2', '-', '+', ' ', '0x', ' 0x ', '0xg', '٢', 'ⅷ', '0b2', '0o8', '08', '0d10', ' 0b 1', '0 b1', '1_', '_', '__', '+_2', '-_0x2', '0_b1']
for s in cases:
    try:
        print(repr(s), '->', R(1) << s)
    except Exception as e:
        print(repr(s), '!!', type(e).__name__, str(e)[:60])

for lab, s in [('0*10^6+2', '0'*10**6 + '2'), ('_*10^6+2', '_'*10**6 + '2'), ('sp*10^6+2', ' '*10**6 + '2'), ('2+sp*10^6', '2' + ' '*10**6),
               ('1*10^6+_*10^6', '1'*10**6 + '_'*10**6), ('1*5000', '1'*5000), ('1*10^6+x', '1'*10**6 + 'x'), ('0x+0*1000+1', '0x' + '0'*1000 + '1'),
               ('-+0*1000+3', '-' + '0'*1000 + '3'), ('b0*10^6+2', b'0'*10**6 + b'2'), ('2^63-1', '9223372036854775807'), ('0x8000000000000000', '0x8000000000000000')]:
    try:
        print(lab, '->', RealField(30)(1) << s)
    except Exception as e:
        print(lab, '!!', type(e).__name__)
