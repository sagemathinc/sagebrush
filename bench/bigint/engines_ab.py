"""The engines with num-bigint (sagebrush-bigint's feature num-backend) and with dashu (the default):
same workloads, wall time (best of two), identical output required.

    cd engine && for v in num dashu; do CARGO_TARGET_DIR=/tmp/t-$v cargo build --release \\
        -p sagebrush-classgroup -p sagebrush-modsym -p sagebrush-cli --examples --bins $([ $v = num ] && echo --features sagebrush-bigint/num-backend); done
    python3 bench/bigint/engines_ab.py
"""
import re, subprocess, sys, time

WORK = [
    ("bnf cubic 10^28", ["bnf", "-6529942,4086470,6831797,1"]),
    ("bnf cubic 10^32", ["bnf", "57930755,90028707,-40701892,1"]),
    ("bnf cubic (PARI bug field)", ["bnf", "-5077,838398,0,1"]),
    ("bnf quartic 10^29", ["bnf", "-82422,-31173,-87551,44103,1"]),
    ("bnf quintic 10^23", ["bnf", "230,911,-538,-513,-293,1"]),
    ("bnf sextic 10^23", ["bnf", "94,-74,-42,75,-93,68,1"]),
    ("imag. quadratic 10^40", ["qcl", "-10000000000000000000000000000000000000003"]),
    ("real quadratic 4(10^25+3)", ["qcl", "40000000000000000000000012"]),
    ("ECM 2^128+1", ["factorbench"]),
    ("exact T_2 charpoly, level 5077", ["sagebrush", "modsym", "5077", "2", "--exact", "--threads", "1"]),
    ("exact T_2 charpoly, level 9001", ["sagebrush", "modsym", "9001", "2", "--exact", "--threads", "1"]),
]


def run(variant, cmd):
    exe = "/tmp/t-%s/release/%s%s" % (variant, "" if cmd[0] == "sagebrush" else "examples/", cmd[0])
    best, out = 1e9, ""
    for _ in range(2):
        t = time.time()
        p = subprocess.run([exe] + cmd[1:], capture_output=True, text=True, timeout=1800)
        best = min(best, time.time() - t)
        out = p.stdout
    # drop timings from the output before comparing
    norm = re.sub(r"\d+(\.\d+)? ?(ms|s)\b", "", out)
    norm = re.sub(r"\b(ms|time)[^\n]*", "", norm)
    return best, norm


print("| workload | num-bigint | dashu | speedup |")
print("|---|---:|---:|---:|")
for name, cmd in WORK:
    tn, on = run("num", cmd)
    td, od = run("dashu", cmd)
    flag = "" if on == od else " **OUTPUT DIFFERS**"
    print("| %s | %.2f s | %.2f s | %.2fx%s |" % (name, tn, td, tn / td, flag))
    sys.stdout.flush()
