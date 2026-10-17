# astra's match-statement review probe (overflow_probe.py, dfe4fb6b), compared with CPython 3.14 by test/match.test.ts
def check(label, pattern):
    src='match {}:\n case '+pattern+': pass\n'
    try:
        compile(src,'<overflow>','exec')
        print(label,'accepted')
    except SyntaxError as e:
        print(label,type(e).__name__,e.msg,e.lineno,e.offset,e.end_lineno,e.end_offset)

big='1'+'0'*309
check('huge-int-real', '{'+big+'+0j:x}')
check('huge-negative-int-real', '{-'+big+'+1j:x}')
check('float-inf-real', '{1e309+0j:x}')
check('huge-int-alone', '{'+big+':x}')
