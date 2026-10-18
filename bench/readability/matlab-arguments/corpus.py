#!/usr/bin/env python3
"""Fixed before/after MATLAB argument-validation corpus; execute on a test VM.

This checks identity against our baseline, not correctness against MATLAB.
Every decoded stdout/stderr byte, exit status and timeout flag is compared.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess
import time

PRELUDE = '''import _matlab as m
import numpy as np

def describe(value):
    if value is m.NOVAL: return ('NOVAL',)
    if type(value) is np.ndarray: return ('array',str(value.dtype),value.shape,value.tolist())
    if type(value) is m.Char: return ('Char',m._dims(value),value.text())
    if type(value) is m.Str: return ('Str',value.s)
    if type(value) is m.StrArr: return ('StrArr',value.shape,value.a)
    if type(value) is m.Cell: return ('Cell',value.shape,[describe(x) for x in value.a])
    if type(value) is tuple: return tuple(describe(x) for x in value)
    if type(value) is list: return [describe(x) for x in value]
    return value

def probe(f):
    try: print('value',repr(describe(f())))
    except Exception as e:
        print('error',type(e).__name__,str(e),getattr(e,'identifier',None),getattr(e,'_using',False))
'''


def cases():
    result=[]
    def add(ident, source, mode='python'):
        result.append({'id':ident,'mode':mode,'source':(PRELUDE if mode=='python' else '')+source+'\n'})

    split_inputs = {
        'empty':'[]', 'positionals':'[1.,2.]', 'one-name':'[m.Str("Scale"),3.]',
        'one-char-name':'[m.Char("sCaLe"),3.]', 'pos-name':'[1.,m.Str("Scale"),3.]',
        'duplicates':'[1.,m.Str("Scale"),3.,m.Str("SCALE"),4.]',
        'unknown':'[1.,2.,m.Str("Other"),3.]', 'nontext':'[1.,2.,4.,3.]',
        'odd':'[1.,2.,m.Str("Scale")]', 'trailing-known':'[m.Str("Scale")]',
        'name-as-value':'[1.,2.,m.Str("Scale"),m.Str("Mode")]',
        'two-names':'[1.,2.,m.Str("Mode"),m.Str("x"),m.Str("Scale"),4.]',
        'raw-python-name':'[1.,2.,"Scale",3.]',
    }
    for count in (0,1,2,3):
        for label,args in split_inputs.items():
            add(f'split-{count}-{label}',f'probe(lambda:m.split_nv({args},{count},["Scale","Mode"]))')
    add('nv-copy-last-and-missing','''
a=m.Cell([1.],(1,1)); b=m.Cell([2.],(1,1))
pairs=[('Scale',a),('Scale',b)]
print(m.nv_has(pairs,'Scale'),m.nv_has(pairs,'scale'))
r=m.nv_get(pairs,'Scale'); print(describe(r),r is b)
r.a[0]=7.; print(describe(b))
probe(lambda:m.nv_get(pairs,'Missing'))
''')

    class_values = {
        'double':'2.5', 'logical':'True', 'int8':'np.array([[4]],dtype=np.int8)',
        'single':'np.array([[2.5]],dtype=np.float32)', 'complex':'2+3j',
        'char':'m.Char("65")', 'string':'m.Str("65")',
        'cell':'m.Cell([m.Char("a")],(1,1))',
    }
    for label,value in class_values.items():
        for target in ('double','single','logical','int8','char','string','cell','struct','function_handle','UnknownClass'):
            add(f'class-{label}-{target}',f'v={value}\nprobe(lambda:m.arg_check(v,None,{target!r},1))')

    shape_values = {
        'scalar':'2.', 'row':'np.array([[1.],[2.],[3.]])',
        'column':'np.array([[1.,2.,3.]])', 'matrix':'np.array([[1.,2.],[3.,4.]])',
        'empty-row':'np.zeros((0,1))', 'empty-both':'np.zeros((0,0))',
        'char':'m.Char("abc")', 'cell':'m.Cell([1.,2.,3.],(1,3))',
    }
    shapes=[None,[1,1],[1,None],[None,1],[1,3],[3,1],[2,2],[None,None],[1,3,1],[2,1,2],[0,1]]
    for label,value in shape_values.items():
        for index,shape in enumerate(shapes):
            add(f'shape-{label}-{index}',f'''v={value}
def check():
    r=m.arg_check(v,{shape!r},None,'Value')
    return r is v,describe(r)
probe(check)''')
    for raised in ('m.MatlabError("conversion broke","Conversion:Id")','ValueError("other broke")'):
        add('conversion-error-'+raised.split('(')[0],f'''events=[]
def convert(v,c):
    events.append(('convert',c))
    raise {raised}
def dims(v):
    events.append('dims')
    return (1,1)
m._convert=convert; m._dims=dims
probe(lambda:m.arg_check(True,[2,2],'double',2))
print(events)''')
    add('conversion-before-shape-trace','''events=[]
def convert(v,c): events.append(('convert',v,c)); return 5.
def dims(v): events.append(('dims',v)); return (1,1)
def repmat(v,*shape): events.append(('expand',v,shape)); return 9.
m._convert=convert; m._dims=dims; m.repmat_=repmat
probe(lambda:m.arg_check(True,[2,2],'double',2))
print(events)''')
    for pos in ('1','"Scale"'):
        for behavior in ('success','matlab','python'):
            body={'success':'return 123','matlab':'raise m.MatlabError("bad","Custom:Id")','python':'raise ValueError("bad")'}[behavior]
            add(f'validate-{pos}-{behavior}',f'''events=[]
def thunk():
    events.append('called')
    {body}
probe(lambda:m.validate(thunk,{pos}))
print(events)''')

    simple_validators=['mustBeNumeric','mustBeNumericOrLogical','mustBeReal',
        'mustBeFinite','mustBeNonNan','mustBePositive','mustBeNonnegative',
        'mustBeNegative','mustBeNonpositive','mustBeNonzero','mustBeInteger',
        'mustBeNonempty','mustBeScalarOrEmpty','mustBeText','mustBeTextScalar',
        'mustBeNonzeroLengthText','mustBeNonsparse','mustBeNonmissing','mustBeValidVariableName']
    values={'zero':'0.','negative':'-1.','positive':'2.','fraction':'1.5','nan':'float("nan")',
        'infinity':'float("inf")','complex-zero':'complex(2,0)','complex-imag':'complex(2,1)',
        'empty':'np.zeros((0,0))','mixed':'np.array([[1.],[-1.]])','logical':'True',
        'char':'m.Char("abc")','empty-char':'m.Char("")','char-column':'m.Char(np.array([[65.,66.]]))',
        'string':'m.Str("abc")','empty-string':'m.Str("")','strings':'m.StrArr(["a",""],(1,2))',
        'cellstr':'m.Cell([m.Char("a"),m.Char("")],(1,2))','empty-cell':'m.Cell([],(0,0))'}
    for name in simple_validators:
        for label,value in values.items():
            add(f'{name}-{label}',f'probe(lambda:m._B[{name!r}].f(0,{value}))')
    for label,value in shape_values.items():
        for opt in ('','m.Str("allow-all-empties")','1.'):
            add(f'vector-{label}-{opt}',f'probe(lambda:m.mustBeVector_(0,{value}{","+opt if opt else ""}))')
    for name in ('mustBeGreaterThan','mustBeGreaterThanOrEqual','mustBeLessThan','mustBeLessThanOrEqual'):
        for label,value in {'empty':'np.zeros((0,0))','one':'1.','row':'np.array([[1.],[3.]])','nan':'float("nan")'}.items():
            for bound in ('2.','np.array([[0.,4.]])'):
                add(f'compare-{name}-{label}-{bound}',f'probe(lambda:m._B[{name!r}].f(0,{value},{bound}))')
    for label,value in {'empty':'np.zeros((0,0))','low':'0.','high':'1.','middle':'.5','nan':'float("nan")'}.items():
        for opt in ('','m.Str("EXCLUSIVE")','m.Char("exclude-lower")','m.Str("exclude-upper")','m.Str("unused")','42.'):
            add(f'range-{label}-{opt}',f'probe(lambda:m.mustBeInRange_(0,{value},0.,1.{","+opt if opt else ""}))')
    for name in ('mustBeA','mustBeUnderlyingType'):
        for label,value in class_values.items():
            for types in ('m.Char("double")','m.Cell([m.Char("double"),m.Char("logical")],(1,2))','m.StrArr(["double","char"],(1,2))'):
                add(f'type-{name}-{label}-{types}',f'probe(lambda:m._B[{name!r}].f(0,{value},{types}))')
    for value, members in [('1.','np.array([[1.],[2.]])'),('3.','np.array([[1.],[2.]])'),('np.zeros((0,0))','np.array([[1.]])'),('m.Str("x")','m.StrArr(["a","b"],(1,2))'),('m.Char("x")','m.Cell([m.Char("a"),m.Char("b")],(1,2))')]:
        add(f'member-{value}-{members}',f'probe(lambda:m.mustBeMember_(0,{value},{members}))')
    # Files/folders are checked only against a fixed repository fixture and a
    # deliberately absent relative path. No external environment is inspected.
    for kind in ('File','Folder'):
        for target in ('lib/_matlab.py','lib','bench/readability/matlab-arguments/does-not-exist'):
            add(f'{kind}-{target}',f'probe(lambda:m._B["mustBe{kind}"].f(0,m.Char({target!r})))')

    function='''function r = f(a,b,opts)
arguments
  a (1,1) double {mustBePositive}
  b (1,:) double = [1 2]
  opts.Scale (1,1) double {mustBePositive} = 1
end
r = a + sum(b)*opts.Scale;
end
'''
    calls=['f(2)','f(2,[3 4])','f(2,Scale=3)','f(2,scale=3)','f(2,[3;4],Scale=3)',
           'f(2,[3 4],Scale=2,Scale=3)','f(0)','f([1 2])','f(2,[1 2;3 4])',
           'f(2,Other=3)','f(2,[1 2],Scale=-1)',"f(2,[1 2],'Scale')"]
    for index,call in enumerate(calls):
        add(f'arguments-end-to-end-{index}',f'''{function}
try
  disp({call});
catch e
  disp(e.identifier);
  disp(e.message);
end
''','matlab')
    return result


def run_one(case, repo, timeout):
    command=['node',str(repo/'dist/src/cli.js')]
    if case['mode']=='matlab': command+=['--matlab']
    else: command+=['-c',case['source']]
    start=time.monotonic()
    try:
        p=subprocess.run(command,input=case['source'] if case['mode']=='matlab' else '',text=True,capture_output=True,cwd=repo,timeout=timeout)
        outcome={'stdout':p.stdout,'stderr':p.stderr,'exit_code':p.returncode,'timeout':False}
    except subprocess.TimeoutExpired as e:
        def decoded(v): return v.decode(errors='replace') if isinstance(v,bytes) else v or ''
        outcome={'stdout':decoded(e.stdout),'stderr':decoded(e.stderr),'exit_code':None,'timeout':True}
    return {**case,**outcome,'seconds':round(time.monotonic()-start,3)}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo',required=True,type=Path)
    p.add_argument('--out',required=True,type=Path)
    p.add_argument('--baseline',type=Path)
    p.add_argument('--jobs',type=int,default=3)
    p.add_argument('--timeout',type=int,default=120)
    p.add_argument('--id',action='append',help='smoke subset; recorded corpus uses every case')
    a=p.parse_args(); repo=a.repo.resolve(); a.out.parent.mkdir(parents=True,exist_ok=True)
    selected=[c for c in cases() if not a.id or c['id'] in a.id]
    results=[]
    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        for record in pool.map(lambda c:run_one(c,repo,a.timeout),selected):
            results.append(record)
            a.out.with_suffix('.partial.json').write_text(json.dumps(results,indent=2)+'\n')
            print(record['id'],record['exit_code'],record['seconds'],flush=True)
    report={'revision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),
        'source_sha256':hashlib.sha256((repo/'lib/_matlab.py').read_bytes()).hexdigest(),'records':results}
    if a.baseline:
        before=json.loads(a.baseline.read_text())['records']
        comparable=lambda rows:[{k:v for k,v in row.items() if k!='seconds'} for row in rows]
        old,new=comparable(before),comparable(results)
        report.update(identical=old==new,baseline_count=len(old),differences=[r['id'] for i,r in enumerate(new) if i>=len(old) or r!=old[i]])
    a.out.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='records'}),flush=True)
    if any(r['timeout'] for r in results) or (a.baseline and not report['identical']): raise SystemExit(1)


if __name__=='__main__': main()
