#!/usr/bin/env python3
"""Freeze and compare map behavior through Sagebrush's CLI; run on a test VM.

No external Magma installation is used. This is a before/after identity check,
not an oracle-correctness claim. Every process output byte and exit status counts.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess
import time

HERE = Path(__file__).resolve().parent


def cases(repo):
    result = []

    def add(name, source, mode="magma"):
        result.append({"id": name, "mode": mode, "source": source + "\n"})

    add("existing-session-fixture", (repo / "magma-tests/test_stdin_maps.m").read_text())
    for offset in range(-5, 6):
        for value in (-3, 0, 4):
            add(f"rule-{offset}-{value}", f"""
f:=map<Integers()->Integers()|x:->x+({offset}),y:->y-({offset})>;
g:=map<Integers()->Integers()|x:->3*x,y:->y div 3>;
f({value}), {value} @ f, ({value}) @@ f;
(f*g)({value}), ({value}) @@ (f*g), Inverse(f*g)({value});
f, Inverse(f), Inverse(Inverse(f)), Domain(f*g), Codomain(f*g);
""")
    graphs = {
        "valid": "[<1,4>,<2,5>,<3,4>]",
        "permuted": "[<3,4>,<1,4>,<2,5>]",
        "missing": "[<1,4>,<3,4>]",
        "empty": "[]",
        "duplicate-same": "[<1,4>,<1,4>,<2,5>,<3,4>]",
        "duplicate-other": "[<1,4>,<1,5>,<2,5>,<3,4>]",
        "bad-domain": "[<0,4>,<2,5>,<3,4>]",
        "bad-codomain": "[<1,9>,<2,5>,<3,4>]",
        "duplicate-and-bad": "[<0,9>,<0,4>]",
        "bad-shape": "[<1,4,5>]",
    }
    for kind in ("map", "pmap"):
        for domain in ("{1,2,3}", "[1,2,3]", "[1..3]"):
            for label, graph in graphs.items():
                add(f"graph-{kind}-{domain}-{label}", f"""
f:={kind}<{domain}->{{4,5}}|{graph}>;
f; f(1); f(2); f(3); f(7); Image(f); Inverse(f); 4 @@ f;
""")
    codomains = ["Integers()", "Rationals()", "GF(7)", "Integers(5)",
                 "PolynomialRing(Integers())", "PolynomialRing(Rationals())",
                 "PolynomialRing(GF(7))", "{1,2,3}", "{Rationals()|1,2,3}",
                 "{1/2,1}", '{"a","b"}']
    for index, codomain in enumerate(codomains):
        for label, argument in [("empty", "{}"), ("typed-empty", "{Integers()|}"),
                                ("single", "{1}"), ("many", "{1,2,3}"),
                                ("outside", "{1,8}")]:
            rule = '"a"' if index == 10 else '1' if index == 9 else 'x'
            add(f"image-{index}-{label}", f"""
f:=map<Integers()->{codomain}|x:->{rule}>;
S:=f({argument}); S; Universe(S); #S;
if #S gt 0 then Type(Setseq(S)[1]); end if;
""")
    edge_sources = {
        "scalar-set": 'f:=map<{{1,2},{3}}->Integers()|s:->#s>; f({1,2}); f({3});',
        "arrow-pairs": 'f:=map<{1,2,3}->{4,5}|3->4,2->5,1->4>; f; Image(f);',
        "set-graph": 'f:=map<{1,2,3}->{4,5}|{<3,4>,<2,5>,<1,4>}>; f; Image(f);',
        "hom-rule": 'f:=hom<Integers()->Integers()|x:->x+1>; f(2);',
        "pmap-rule": 'f:=pmap<{1,2}->{4,5}|x:->x+3>; f(0); f(1); f(3);',
        "graph-infinite": 'map<Integers()->Integers()|1->2>; map<Rationals()->Rationals()|1->2>;',
        "partial-infinite": 'f:=pmap<Integers()->Integers()|1->2>; f(1); f(2);',
        "graph-unsupported-domain": 'map<GF(3)->GF(3)|[<GF(3)!0,GF(3)!0>]>;',
        "graph-empty-domain": 'f:=map<{}->{}|[]>; f; Image(f); f(1);',
        "inverse-missing": 'f:=map<Integers()->Integers()|x:->x+1>; g:=Inverse(f); g; g(1); 1 @@ f; Inverse(g)(1);',
        "inverse-membership": 'f:=map<Integers()->Integers()|x:->x,y:->y/2>; 4 @@ f; 3 @@ f; (1/2) @@ f; Inverse(f)(3);',
        "composition-mismatch": 'f:=map<Integers()->Rationals()|x:->x>; g:=map<Integers()->Integers()|x:->x>; f*g;',
        "composition-equal-domain": 'f:=map<{1,2}->{3,4}|x:->x+2>; g:=map<{4,3}->{5,6}|x:->x+2>; (f*g)(1);',
        "composition-graph-inverse": 'f:=map<{1}->{2}|1->2>; g:=map<{2}->{3}|x:->3,y:->2>; Inverse(f*g);',
        "image-rule-refused": 'f:=map<Integers()->Integers()|x:->x>; Image(f);',
        "rule-domain-error": 'f:=map<Integers()->Integers()|x:->x>; f(1/2);',
        "rule-codomain-error": 'f:=map<Integers()->Integers()|x:->x/2>; f(1); f(2);',
        "intrinsic-type-errors": 'Inverse(2); Image(2); 2 @@ 3;',
    }
    for name, source in edge_sources.items():
        add(name, source)

    # Callback traces pin validation/coercion order and error provenance. These
    # invoke our runtime implementation from Python, not external Magma code.
    for input_ok, output_ok, inverse in [(True,True,False),(False,True,False),
                                        (True,False,False),(True,True,True),
                                        (False,True,True),(True,False,True)]:
        add(f"callback-{input_ok}-{output_ok}-{inverse}", f'''
import _magma as m
events=[]
class Domain:
    def __init__(self,name,allowed): self.name,self.allowed=name,allowed
    def _magma_contains(self,x):
        events.append((self.name,"contains",x))
        return self.allowed
    def _magma_coerce(self,x):
        events.append((self.name,"coerce",x))
        return x+100
def rule(x):
    events.append(("rule",x))
    return x+1
def inverse(x):
    events.append(("inverse",x))
    return x-1
f=m.MMap(Domain("domain",{output_ok if inverse else input_ok}),Domain("codomain",{input_ok if inverse else output_ok}),rule,inverse)
try:
    print(m._preimage(f,4,(12,7)) if {inverse} else f(4))
except m.MagmaError as e:
    print(type(e).__name__,str(e),e.where,e.pos)
print(events)
''', "python")
    add("existing-error-position", '''
import _magma as m
def fail(x): raise m.MagmaError("inner", "rule", True, (3,5))
f=m.MMap(m._ZZ,m._ZZ,lambda x:x,fail)
try: m._preimage(f,1,(12,7))
except m.MagmaError as e: print(str(e), e.where, e.pos)
try: m._map("map",m._ZZ,m._ZZ,pairs=[(1,2)],pos=(4,6))
except m.MagmaError as e: print(str(e), e.where, e.pos)
''', "python")
    return result


def run_one(case, repo, timeout):
    command = ["node", str(repo / "dist/src/cli.js")]
    if case["mode"] == "magma":
        command += ["--magma"]
    else:
        command += ["-c", case["source"]]
    start = time.monotonic()
    try:
        p = subprocess.run(command, input=case["source"] if case["mode"] == "magma" else "",
                           text=True, capture_output=True, cwd=repo, timeout=timeout)
        outcome = {"stdout": p.stdout, "stderr": p.stderr, "exit_code": p.returncode, "timeout": False}
    except subprocess.TimeoutExpired as error:
        def decoded(value):
            return value.decode(errors="replace") if isinstance(value,bytes) else value or ""
        outcome = {"stdout": decoded(error.stdout), "stderr": decoded(error.stderr),
                   "exit_code": None, "timeout": True}
    return {**case, **outcome, "seconds": round(time.monotonic()-start,3)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    repo = args.repo.resolve()
    args.out.parent.mkdir(parents=True,exist_ok=True)
    all_cases = cases(repo)
    revision = subprocess.check_output(["git","rev-parse","HEAD"],cwd=repo,text=True).strip()
    source = repo / "lib/_magma.py"
    results=[]
    with ThreadPoolExecutor(max_workers=args.jobs) as executor:
        for record in executor.map(lambda case:run_one(case,repo,args.timeout),all_cases):
            results.append(record)
            args.out.with_suffix(".partial.json").write_text(json.dumps(results,indent=2)+"\n")
            print(record["id"],record["exit_code"],record["seconds"],flush=True)
    report={"revision":revision,"source_sha256":hashlib.sha256(source.read_bytes()).hexdigest(),
            "records":results}
    if args.baseline:
        before=json.loads(args.baseline.read_text())["records"]
        comparable=lambda records:[{k:v for k,v in r.items() if k!="seconds"} for r in records]
        old,new=comparable(before),comparable(results)
        report["identical"]=old==new
        report["differences"]=[r["id"] for i,r in enumerate(new) if i>=len(old) or r!=old[i]]
        report["baseline_count"]=len(old)
    args.out.write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({k:v for k,v in report.items() if k!="records"}),flush=True)
    if any(r["timeout"] for r in results) or (args.baseline and not report["identical"]):
        raise SystemExit(1)


if __name__=="__main__":
    main()
