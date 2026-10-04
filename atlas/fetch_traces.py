"""LMFDB mf_newforms (weight >= 2, N k^2 <= BOUND): label, space, orbit
index, dim and the trace form tr a_n for n <= 1000."""
import json, sys, psycopg
BOUND = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
conn = dict(host='devmirror.lmfdb.xyz', port=5432, dbname='lmfdb', user='lmfdb', password='lmfdb', connect_timeout=20)
with open(f"mf_newforms_traces_Nk2le{BOUND}.jsonl", "w") as out, psycopg.connect(**conn) as c:
    for w in range(2, int(BOUND ** 0.5) + 2):
        for r in c.execute("select label, space_label, hecke_orbit, dim, traces from mf_newforms where weight = %s and level*weight*weight <= %s order by level, char_orbit_index, hecke_orbit", (w, BOUND)).fetchall():
            out.write(json.dumps(dict(label=r[0], space=r[1], orbit=r[2], dim=r[3], traces=[str(x) for x in r[4]])) + "\n")
