"""Builds atlas M0 in a local directory from Sagebrush computations and an
LMFDB mirror slice:  python build_m0.py ROOT

Inputs (see README.md for how each was produced):
  ~/data/atlas-src/rational_newforms_le9999.jsonl   sagebrush rational_table 11 9999
  ~/data/atlas-src/orbits_le1000.jsonl              sagebrush integral 1-1000
  ~/data/lmfdb/mf_newforms_wt2_triv_le9999_tracep.jsonl, ec_curvedata_le9999.jsonl  (fetch_m0.py)
  ~/data/ecdata/aplist.00000-09999                  Cremona's ecdata
"""
import json, os, sys, time
from collections import defaultdict
import pyarrow as pa
import flint
import atlas
from sagebrush import ap as sb_ap

HOME = os.path.expanduser("~")
ROOT = sys.argv[1]
SB = os.path.join(HOME, "sagebrush")
COMMIT = atlas.git_commit(SB)
PRIMES = [p for p in range(2, 1000) if all(p % d for d in range(2, int(p**0.5) + 1))]
TODAY = time.strftime("%Y-%m-%d")


def sha256(path):
    """The SHA-256 of an input file: the immutable identity of what was packaged."""
    import hashlib
    h = hashlib.sha256()
    with open(os.path.expanduser(path), "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


# Precomputed inputs record their own producer (or not); this script's
# checkout is only the packaging revision (systematic review DAT-F4).
INPUTS = {name: sha256(path) for name, path in [
    ("rational_newforms", "~/data/atlas-src/rational_newforms_le9999.jsonl"),
    ("orbits", "~/data/atlas-src/orbits_le1000.jsonl"),
    ("lmfdb_newforms", "~/data/lmfdb/mf_newforms_wt2_triv_le9999_tracep.jsonl"),
    ("lmfdb_curves", "~/data/lmfdb/ec_curvedata_le9999.jsonl"),
    ("cremona_aplist", "~/data/ecdata/aplist.00000-09999")]}

def jsonl(path):
    with open(os.path.expanduser(path)) as f:
        for line in f:
            yield json.loads(line)

def good(n):
    return [p for p in PRIMES if n % p]

def ap_vector(n, d):
    """a_p for every prime p < 1000 (None where p | N) from {p: a_p}."""
    return [d.get(p) if n % p else None for p in PRIMES]

# ---- sources --------------------------------------------------------------
t0 = time.time()
lmfdb = list(jsonl("~/data/lmfdb/mf_newforms_wt2_triv_le9999_tracep.jsonl"))
lmfdb_key = {}
for r in lmfdb:
    n = r["level"]
    tr = dict(zip(PRIMES, r["trace_ap"]))
    lmfdb_key[(n, r["dim"], tuple(tr[p] for p in good(n)))] = r
cremona = defaultdict(list)
for line in open(os.path.join(HOME, "data/ecdata/aplist.00000-09999")):
    w = line.split()
    n = int(w[0])
    # 25 columns, p < 100; extra fields like "-(109)" are signs at bad primes > 100.
    cremona[n].append(tuple(int(a) for p, a in zip(PRIMES[:25], w[2:27]) if n % p))
curves = list(jsonl("~/data/lmfdb/ec_curvedata_le9999.jsonl"))
print(f"sources: {len(lmfdb)} LMFDB newforms, {len(curves)} LMFDB curves, {sum(map(len, cremona.values()))} Cremona classes ({time.time()-t0:.0f} s)", flush=True)

# Point counts with sagebrush.ap: one curve per LMFDB isogeny class.
t0 = time.time()
class_rep = {}
for c in curves:
    class_rep.setdefault(c["iso"], c)
reps = list(class_rep.values())
counts = sb_ap.aplist_many([c["ainvs"] for c in reps], 999)
class_ap = {}
for c, lst in zip(reps, counts):
    n = c["conductor"]
    d = dict(lst)
    class_ap[c["iso"]] = tuple(d[p] for p in good(n))
print(f"point counts: {len(reps)} isogeny classes x {len(PRIMES)} primes ({time.time()-t0:.0f} s)", flush=True)
iso_by_key = {(c["conductor"], class_ap[c["iso"]]): c["iso"] for c in reps}

# ---- certificates ---------------------------------------------------------
cert_rational = atlas.put_certificate(ROOT,
    claim="a_p (p < 1000, p not dividing N) of every rational weight-2 newform on Gamma0(N), 11 <= N <= 9999",
    method="Split the dual of the sign +1 modular symbols mod 2147483629 by integer T_q eigenvalues in the Hasse range; "
           "old systems explained by lower levels with multiplicity d(N/M); a_p = psi(T_p x)/psi(x) from one Heilbronn sum per prime "
           "(sagebrush-modsym newforms.rs).",
    checks=["equal to Cremona's ecdata aplist (p < 100) for all isogeny classes", "equal to LMFDB mf_newforms traces (p < 1000)",
            "equal to point counts by sagebrush-ap on an LMFDB curve of the class (p < 1000)", "Hasse bound at every p"],
    recipe={"repository": "https://github.com/sagemathinc/sagebrush", "packaging_commit": COMMIT, "producer_commit": "unrecorded",
            "input_sha256": INPUTS["rational_newforms"],
            "command": "cd engine && cargo run --release -p sagebrush-modsym --example rational_table -- OUT.jsonl 11 9999"})
cert_orbits = atlas.put_certificate(ROOT,
    claim="Galois orbits of weight-2 newforms on Gamma0(N), 1 <= N <= 1000: dimension, tr(a_p) (p < 1000, p not dividing N), "
          "and exact integer coordinates of a_p",
    method="Factor chi(T) for T = sum r_i T_{q_i} with super-increasing r_i (FLINT); new orbits are the non-Eisenstein factors of exponent one "
           "(Eisenstein factors divide the charpoly of T on the boundary image); dual bases by Krylov iteration; exact rational echelon "
           "basis by CRT of two primes and rational reconstruction, checked mod a third and then exactly (every 3-term relation and "
           "w o f(T) = 0 over Z, from integral.rs since the systematic review's MOD-F9; earlier inputs had only the modular checks); "
           "c_{p,r} = w_r(T_p x) by integer Heilbronn sums; "
           "coordinates reduced by HNF of the c_p lattice and LLL (python-flint).",
    checks=["sum of orbit dimensions equals dim S_2^new(N) at every level", "tr(a_p) = sum_r c_{p,r} tr(beta_r) at every prime (mod ell)",
            "dimensions and tr(a_p) equal to LMFDB mf_newforms for every orbit"],
    recipe={"repository": "https://github.com/sagemathinc/sagebrush", "packaging_commit": COMMIT, "producer_commit": "unrecorded",
            "input_sha256": INPUTS["orbits"],
            "command": "cd engine && cargo run --release -p sagebrush-modsym --example integral -- OUT.jsonl 1-1000"})
cert_curves = atlas.put_certificate(ROOT,
    claim="for each LMFDB elliptic curve of conductor <= 9999, a_p (p < 1000, good) by point counting equals a_p of the rational newform of the same level",
    method="sagebrush-ap: baby-step giant-step in the Hasse interval on E or its quadratic twist, unique match (a Rust port of smalljac's genus-1 strategy)",
    checks=["equality with the rational newform's a_p from modular symbols, and with LMFDB's traces"],
    recipe={"repository": "https://github.com/sagemathinc/sagebrush", "commit": COMMIT,  # computed here: the producer
            "input_sha256": INPUTS["lmfdb_curves"],
            "command": "python -c 'from sagebrush import ap; ap.aplist([a1,a2,a3,a4,a6], 999)'"})
cert_import = atlas.put_certificate(ROOT,
    claim="rows copied from the LMFDB (tables mf_newforms, ec_curvedata) for weight 2, trivial character, level <= 9999",
    method="read-only LMFDB Postgres mirror devmirror.lmfdb.xyz, queried in level-range chunks",
    checks=[], recipe={"date": TODAY, "script": "data/lmfdb/fetch_m0.py (atlas-src)", "source": "https://www.lmfdb.org",
                       "input_sha256": {k: INPUTS[k] for k in ("lmfdb_newforms", "lmfdb_curves")},
                       # (DAT-F5: the source's data reuse terms are still to be confirmed and recorded)
                       "reuse_terms": "not recorded: to be confirmed with the LMFDB"})

ours_src = f"sagebrush-modsym@{COMMIT[:12] if COMMIT else 'unknown'}"

# ---- mf/rational_newforms_wt2 ---------------------------------------------
rational_rows, label_of_rational = [], {}
disputes = []
for r in jsonl("~/data/atlas-src/rational_newforms_le9999.jsonl"):
    n = r["level"]
    d = dict((p, a) for p, a in r["ap"])
    key = tuple(d[p] for p in good(n))
    lm = lmfdb_key.get((n, 1, key))
    small = len([p for p in PRIMES if p < 100 and n % p])
    crem_ok = key[:small] in cremona.get(n, [])
    iso = iso_by_key.get((n, key))
    sources = [ours_src] + (["lmfdb:mf_newforms"] if lm else []) + (["cremona:ecdata"] if crem_ok else []) + (["sagebrush-ap:point-counts"] if iso else [])
    status = "checked" if lm and crem_ok and iso else "disputed"
    if status == "disputed":
        disputes.append(("rational", n, bool(lm), crem_ok, bool(iso)))
    label = lm["label"] if lm else None
    label_of_rational[(n, key)] = label
    rational_rows.append({"label": label, "level": n, "ap": ap_vector(n, d), "ec_isogeny_class": iso,
                          "analytic_rank": lm["analytic_rank"] if lm else None,
                          "source": sources, "status": status, "certificate": cert_rational})

AP = pa.list_(pa.int32())
std = [{"name": "source", "arrow": pa.list_(pa.string()), "description": "sources that produced or confirmed the row"},
       {"name": "status", "arrow": pa.string(), "description": "imported < computed < checked < proven, or disputed"},
       {"name": "certificate", "arrow": pa.string(), "description": "sha256 of the certificate (certs/<sha>.json)"}]
conv_ap = "ap[i] is a_p for the i-th prime p < 1000 (2, 3, 5, ..., 997); null where p divides the level"
m1 = atlas.write_table(ROOT, "mf", "rational_newforms_wt2", rational_rows, {
    "version": 1, "conventions": [conv_ap, "weight 2, trivial character, Gamma0(N); labels are LMFDB newform labels"],
    "columns": [{"name": "label", "arrow": pa.string(), "description": "LMFDB label N.2.a.x"},
                {"name": "level", "arrow": pa.int32(), "description": "N"},
                {"name": "ap", "arrow": AP, "description": "a_p, p < 1000 (see conventions)"},
                {"name": "ec_isogeny_class", "arrow": pa.string(), "description": "LMFDB label of the isogeny class of elliptic curves (by point counts)"},
                {"name": "analytic_rank", "arrow": pa.int32(), "description": "from LMFDB (imported)"}] + std},
    key="level", shard_size=10000, description="Rational weight-2 newforms (elliptic curves over Q up to isogeny), N <= 9999")
print("rational_newforms_wt2:", m1["rows"], m1["status_counts"], flush=True)

# ---- mf/newform_orbits_wt2 ------------------------------------------------
def reduce_coordinates(k, c):
    """HNF of the c_p lattice, then LLL of the coordinate sequences."""
    C = flint.fmpz_mat([[cp[r] for _, cp in c] for r in range(k)])
    B = C.transpose().hnf()
    B = flint.fmpz_mat([B.tolist()[i] for i in range(k)]).transpose()
    Y = flint.fmpz_mat([[int(x) for x in row] for row in B.solve(C).tolist()]).lll()
    rows = Y.tolist()
    return [[int(rows[r][j]) for r in range(k)] for j in range(len(c))]

orbit_rows = []
for r in jsonl("~/data/atlas-src/orbits_le1000.jsonl"):
    n, k = r["level"], r["dim"]
    tr = dict(zip(good(n), r["traces"]))
    lm = lmfdb_key.get((n, k, tuple(r["traces"])))
    status = "checked" if lm and r["traces_check"] else "disputed"
    if status == "disputed":
        disputes.append(("orbit", n, k, bool(lm), r["traces_check"]))
    y = reduce_coordinates(k, r["c"])
    orbit_rows.append({"label": lm["label"] if lm else None, "level": n, "dim": k,
                       "hecke_poly": r["f"], "hecke_operator": [[q, rr] for q, rr in r["ops"]],
                       "lmfdb_field_poly": lm["field_poly"] if lm else None,
                       "trace_ap": ap_vector(n, tr), "ap_coordinates": y,
                       "source": [ours_src] + (["lmfdb:mf_newforms"] if lm else []), "status": status, "certificate": cert_orbits})
m2 = atlas.write_table(ROOT, "mf", "newform_orbits_wt2", orbit_rows, {
    "version": 1,
    "conventions": ["trace_ap[i] is tr_{K/Q}(a_p) for the i-th prime p < 1000; null where p | N",
                    "ap_coordinates[j] is the integer vector y_p for the j-th prime p < 1000 not dividing N: a_p = sum_r beta_r y_{p,r} "
                    "(Stein's representation after HNF + LLL); the beta_r in K are not yet stored (M1)",
                    "hecke_poly is the charpoly (constant term first, decimal strings) of hecke_operator = sum r T_q on the orbit; it defines the Hecke field K"],
    "columns": [{"name": "label", "arrow": pa.string(), "description": "LMFDB label N.2.a.x"},
                {"name": "level", "arrow": pa.int32(), "description": "N"},
                {"name": "dim", "arrow": pa.int32(), "description": "dimension of the orbit = [K : Q]"},
                {"name": "hecke_poly", "arrow": pa.list_(pa.string()), "description": "irreducible charpoly of hecke_operator on the orbit"},
                {"name": "hecke_operator", "arrow": pa.list_(pa.list_(pa.int64())), "description": "[[q, r], ...]: the operator sum r T_q"},
                {"name": "lmfdb_field_poly", "arrow": pa.list_(pa.int64()), "description": "LMFDB's polredabs Hecke field polynomial (imported)"},
                {"name": "trace_ap", "arrow": pa.list_(pa.int64()), "description": "traces of a_p"},
                {"name": "ap_coordinates", "arrow": pa.list_(pa.list_(pa.int64())), "description": "integer coordinates of a_p (see conventions)"}] + std},
    key="level", shard_size=2000, description="Galois orbits of weight-2 newforms on Gamma0(N), N <= 1000, with exact compact a_p")
print("newform_orbits_wt2:", m2["rows"], m2["status_counts"], flush=True)

# ---- ec/curves -------------------------------------------------------------
curve_rows = []
for c in curves:
    n = c["conductor"]
    key = class_ap[c["iso"]]
    label = label_of_rational.get((n, key))
    status = "checked" if label else "disputed"
    if not label:
        disputes.append(("curve", c["label"]))
    curve_rows.append({**{k: c[k] for k in ["label", "iso", "cremona_label", "conductor", "ainvs", "rank", "analytic_rank", "torsion", "cm"]},
                       "newform": label, "source": ["lmfdb:ec_curvedata", "sagebrush-ap:point-counts"] + ([ours_src] if label else []),
                       "status": status, "certificate": cert_curves})
m3 = atlas.write_table(ROOT, "ec", "curves", curve_rows, {
    "version": 1, "conventions": ["ainvs are [a1, a2, a3, a4, a6] of LMFDB's (minimal) model"],
    "columns": [{"name": "label", "arrow": pa.string(), "description": "LMFDB curve label"},
                {"name": "iso", "arrow": pa.string(), "description": "LMFDB isogeny class label"},
                {"name": "cremona_label", "arrow": pa.string(), "description": "Cremona label"},
                {"name": "conductor", "arrow": pa.int32(), "description": "conductor"},
                {"name": "ainvs", "arrow": pa.list_(pa.int64()), "description": "Weierstrass coefficients"},
                {"name": "rank", "arrow": pa.int32(), "description": "from LMFDB (imported)"},
                {"name": "analytic_rank", "arrow": pa.int32(), "description": "from LMFDB (imported)"},
                {"name": "torsion", "arrow": pa.int32(), "description": "torsion order, from LMFDB (imported)"},
                {"name": "cm", "arrow": pa.int32(), "description": "CM discriminant or 0, from LMFDB (imported)"},
                {"name": "newform", "arrow": pa.string(), "description": "label of the rational newform with the same a_p (modularity, checked)"}] + std},
    key="conductor", shard_size=20000, description="Elliptic curves over Q of conductor <= 9999 (LMFDB), point-counted and linked to their newforms")
print("ec/curves:", m3["rows"], m3["status_counts"], flush=True)

# ---- lmfdb/mf_newforms_wt2 (imported slice) --------------------------------
recomputed = {(r["level"], r["label"]) for r in rational_rows + orbit_rows if r["status"] == "checked" and r["label"]}
import_rows = []
for r in lmfdb:
    ok = (r["level"], r["label"]) in recomputed
    import_rows.append({"label": r["label"], "level": r["level"], "dim": r["dim"], "field_poly": r["field_poly"], "is_cm": r["is_cm"],
                        "analytic_rank": r["analytic_rank"], "trace_ap": r["trace_ap"],
                        "source": ["lmfdb:mf_newforms"] + ([ours_src] if ok else []), "status": "checked" if ok else "imported", "certificate": cert_import})
m4 = atlas.write_table(ROOT, "lmfdb", "mf_newforms_wt2", import_rows, {
    "version": 1, "conventions": ["trace_ap[i] is tr(a_p) for the i-th prime p < 1000 (including p | N, as in LMFDB)"],
    "columns": [{"name": "label", "arrow": pa.string(), "description": "LMFDB label"},
                {"name": "level", "arrow": pa.int32(), "description": "N"},
                {"name": "dim", "arrow": pa.int32(), "description": "dimension"},
                {"name": "field_poly", "arrow": pa.list_(pa.int64()), "description": "Hecke field polynomial (polredabs)"},
                {"name": "is_cm", "arrow": pa.bool_(), "description": "CM"},
                {"name": "analytic_rank", "arrow": pa.int32(), "description": "analytic rank"},
                {"name": "trace_ap", "arrow": pa.list_(pa.int64()), "description": "traces of a_p, p < 1000"}] + std},
    key="level", shard_size=20000, description="LMFDB mf_newforms slice: weight 2, trivial character, level <= 9999")
print("lmfdb/mf_newforms_wt2:", m4["rows"], m4["status_counts"], flush=True)
print("disputes:", len(disputes), disputes[:10])
