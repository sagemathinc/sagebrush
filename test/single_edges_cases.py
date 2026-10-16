# compile(..., 'single') after decorated and inline compound statements, against
# CPython: astra's probe for CORR-50F-2 (test/coverage-fixes.test.ts).
# (astra's match block is left out: match is not supported yet, an older gap)
def check(label,s):
    try:
        compile(s,'p.py','single')
        print(label,'OK')
    except SyntaxError as e:
        print(label,type(e).__name__,e.msg,e.lineno,e.offset,e.end_lineno,e.end_offset,repr(e.text))
    except Exception as e: print(label,type(e).__name__,str(e))
blocks=[
 'if True: a=1; b=2\n',
 'if True:\n    pass\n',
 'if True:\n    # comment\n\n    pass\n',
 'if True:\n    pass\n\n# comment\nelse:\n    pass\n',
 'if True: pass\nelse: pass\n',
 '@deco\ndef f(): pass\n',
 '@deco(x)\n@deco(y)\ndef f():\n    pass\n',
 '@(lambda x: x)\ndef f():\n    pass\n',
 '@deco(\n x)\ndef f(): pass\n',
 'async def f():\n    pass\n',
 'class C:\n    pass\n',
 'try:\n    pass\nexcept ValueError:\n    pass\nelse:\n    pass\nfinally:\n    pass\n',
 'while True:\n    break\nelse:\n    pass\n',
 'for x in []:\n    pass\nelse: pass\n',
 'with x:\n    pass\n',
 'a=(\n1); b=(\n2); c=3\n',
 'a=1; \\\n b=2\n',
 '"#"\n',
 'x="a#b" # suffix\n',
]
for i,b in enumerate(blocks):
    for j,suffix in enumerate(['','x=2\n','\n# blank\nx=2\n','@deco\ndef g():pass\n']):
        check(str(i)+':'+str(j),b+suffix)
