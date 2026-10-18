#!/usr/bin/env python3
"""Fixed before/after iterator corpus. Execute on a test VM, not the project.

Compare exact source, decoded stdout/stderr, exit status and timeout flags.
This checks preservation of existing behavior, not agreement with an oracle.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import itertools
import json
from pathlib import Path
import subprocess
import time

PRELUDE = '''
events = []
def capture(action):
    try:
        value = action()
        print("value", repr(value))
    except BaseException as error:
        print("error", type(error).__name__, str(error), repr(error.args))
class Source:
    def __init__(self, label, count, failure=-1):
        self.label, self.count, self.index, self.failure = label, count, 0, failure
    def __iter__(self):
        events.append((self.label, "iter"))
        return self
    def __next__(self):
        events.append((self.label, "next", self.index))
        if self.index == self.failure:
            self.index += 1
            raise ValueError(self.label + " failed")
        if self.index >= self.count:
            raise StopIteration(self.label + " finished")
        value = self.index
        self.index += 1
        return value
def mapped(*items):
    events.append(("map", items))
    return items
class Truth:
    def __init__(self, value): self.value = value
    def __bool__(self):
        events.append(("truth", self.value))
        if self.value == "error": raise ValueError("truth failed")
        return self.value
'''


def cases():
    result = []
    def add(name, source):
        result.append({"id": name, "source": PRELUDE + source + '\nprint("events", repr(events))\n'})

    lengths = [()] + [(n,) for n in range(4)]
    lengths += list(itertools.product(range(4), repeat=2))
    lengths += list(itertools.product(range(3), repeat=3))
    for kind, strict, counts in itertools.product(("zip", "map"), (False, True), lengths):
        arguments = ','.join(f'Source("s{i}",{n})' for i, n in enumerate(counts))
        arguments = ('mapped' + (',' if arguments else '') + arguments) if kind == 'map' else arguments
        add(f'{kind}-{strict}-{counts}', f'''
def run():
    iterator = {kind}({arguments}, strict={strict!r})
    for attempt in range({max(counts, default=0) + 3}):
        capture(lambda: next(iterator))
capture(run)
''')
    for kind in ('zip', 'map'):
        for failed in range(3):
            for strict in (False, True):
                args = ','.join(f'Source("s{i}",3,{1 if i == failed else -1})' for i in range(3))
                if kind == 'map': args = 'mapped,' + args
                add(f'{kind}-source-error-{failed}-{strict}', f'''
it = {kind}({args},strict={strict!r})
for attempt in range(5): capture(lambda: next(it))
''')
        for args in ('', 'mapped', 'mapped,Source("a",2)') if kind == 'map' else ('', 'Source("a",2)'):
            for keywords in ('strict=Truth(False)', 'strict=Truth(True)', 'strict=Truth("error")',
                             'wrong=Truth("error")', 'strict=Truth("error"),wrong=1',
                             'wrong=1,strict=Truth("error")'):
                joined = args + (',' if args else '') + keywords
                add(f'{kind}-keywords-{args}-{keywords}', f'capture(lambda: list({kind}({joined})))')
    for args in ('None,Source("a",0)', 'None,Source("a",2)', 'Callback(),Source("a",2)',
                 'mapped,Source("a",2),Source("b",1)'):
        add(f'map-callable-{args}', f'''
class Callback:
    def __call__(self,*args):
        events.append(("callback",args))
        return sum(args)
it=map({args})
for attempt in range(4): capture(lambda: next(it))
''')
    for start in ('None','False','True','-3','0','9007199254740989','9007199254740990',
                  '9007199254740991','9007199254740992','10**40','-(10**40)','3.5','"2"'):
        for keyword in (False, True):
            args = f'iterable=Source("a",3),start={start}' if keyword else f'Source("a",3),{start}'
            add(f'enumerate-{start}-{keyword}', f'capture(lambda: list(enumerate({args})))')
    for response in ('4','True','3.5','"error"'):
        add(f'enumerate-index-{response}', f'''
class Start:
    def __index__(self):
        events.append("index")
        value = {response}
        if value == "error": raise ValueError("index failed")
        return value
capture(lambda: list(enumerate(Source("a",2),Start())))
''')
    add('enumerate-stop', '''
it=enumerate(Source("a",1))
for attempt in range(4): capture(lambda: next(it))
''')
    for expression in ('enumerate()', 'enumerate(Source("a",1),0,3)',
                       'enumerate(Source("a",1),iterable=Source("b",1))',
                       'enumerate(Source("a",1),wrong=Truth(True))'):
        add('enumerate-admission-'+expression, f'capture(lambda: list({expression}))')
    for predicate in ('None','bool','lambda x:x%2','Predicate()'):
        add('filter-'+predicate, f'''
class Predicate:
    def __call__(self, item):
        events.append(("predicate",item))
        return Truth(item % 2 == 1)
it=filter({predicate},Source("a",4))
for attempt in range(5): capture(lambda: next(it))
''')
    add('filter-predicate-error', '''
def predicate(item):
    events.append(("predicate",item))
    if item == 1: raise ValueError("predicate failed")
    return item
it=filter(predicate,Source("a",4))
for attempt in range(5): capture(lambda: next(it))
''')
    add('filter-item-truth', '''
it=filter(None,[Truth(False),Truth(True),Truth("error"),Truth(True)])
for attempt in range(5):
    def step():
        value=next(it)
        return value.value
    capture(step)
''')
    for value in ('[]','[1,2,3]','(1,2,3)','range(4)','"a😀𝄞b"','""','b"abc"','42'):
        add('reversed-'+value, f'capture(lambda:list(reversed({value})))')
    for mutation in ('values.append(9)','values.pop()','values[1]=99','values.clear()'):
        add('reversed-live-'+mutation, f'''
values=[1,2,3]
it=reversed(values)
capture(lambda:next(it))
{mutation}
for attempt in range(4): capture(lambda:next(it))
''')
    for hook in ('absent','none','callable','error'):
        definition = '' if hook == 'absent' else '    __reversed__=None\n' if hook == 'none' else '''    def __reversed__(self):
        events.append("reversed")
''' + ('        raise ValueError("hook failed")\n' if hook == 'error' else '        return iter([7,8])\n')
        add('reversed-hook-'+hook, '''
class Sequence:
    def __len__(self):
        events.append("len")
        return 3
    def __getitem__(self,i):
        events.append(("get",i))
        return i+10
''' + definition + '\ncapture(lambda:list(reversed(Sequence())))')
    for bad_index in (-1,1,2):
        add('reversed-get-error-'+str(bad_index), f'''
class Sequence:
    def __len__(self):
        events.append("len")
        return 3
    def __getitem__(self,i):
        events.append(("get",i))
        if i == {bad_index}: raise ValueError("get failed")
        return i+10
it=reversed(Sequence())
for attempt in range(5): capture(lambda:next(it))
''')
    add('reversed-missing-get', '''
class Sequence:
    def __len__(self):
        events.append("len")
        return 3
capture(lambda:reversed(Sequence()))
''')
    for constructor in ('zip(Source("a",1))','map(mapped,Source("a",1))',
                        'enumerate(Source("a",1))','filter(None,Source("a",1))',
                        'reversed([1,2])'):
        add('adapter-'+constructor, f'''
it={constructor}
print(iter(it) is it, type(it).__name__)
for attempt in range(4): capture(lambda:it.__next__())
''')
    return result


def run_one(case, repo, timeout):
    command = ['node', str(repo / 'dist/src/cli.js'), '-c', case['source']]
    start = time.monotonic()
    try:
        run = subprocess.run(command, text=True, capture_output=True, cwd=repo, timeout=timeout)
        outcome = {'stdout':run.stdout,'stderr':run.stderr,'exit_code':run.returncode,'timeout':False}
    except subprocess.TimeoutExpired as error:
        def decoded(value):
            return value.decode(errors='replace') if isinstance(value,bytes) else value or ''
        outcome={'stdout':decoded(error.stdout),'stderr':decoded(error.stderr),'exit_code':None,'timeout':True}
    return {**case, **outcome, 'seconds':round(time.monotonic()-start,3)}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo',required=True,type=Path)
    parser.add_argument('--out',required=True,type=Path)
    parser.add_argument('--baseline',type=Path)
    parser.add_argument('--jobs',type=int,default=4)
    parser.add_argument('--timeout',type=int,default=60)
    args=parser.parse_args()
    repo=args.repo.resolve()
    args.out.parent.mkdir(parents=True,exist_ok=True)
    records=[]
    with ThreadPoolExecutor(max_workers=args.jobs) as executor:
        for record in executor.map(lambda case:run_one(case,repo,args.timeout),cases()):
            records.append(record)
            args.out.with_suffix('.partial.json').write_text(json.dumps(records,indent=2)+'\n')
            print(record['id'],record['exit_code'],record['seconds'],flush=True)
    report={'revision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),
            'source_sha256':hashlib.sha256((repo/'src/runtime/types.ts').read_bytes()).hexdigest(),
            'records':records}
    if args.baseline:
        old=json.loads(args.baseline.read_text())['records']
        comparable=lambda xs:[{k:v for k,v in x.items() if k!='seconds'} for x in xs]
        before,after=comparable(old),comparable(records)
        report['identical']=before==after
        report['differences']=[case['id'] for i,case in enumerate(after) if i>=len(before) or case!=before[i]]
        report['baseline_count']=len(before)
    args.out.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='records'}),flush=True)
    if any(x['timeout'] for x in records) or (args.baseline and not report['identical']):
        raise SystemExit(1)


if __name__=='__main__':
    main()
