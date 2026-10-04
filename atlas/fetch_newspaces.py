"""LMFDB mf_newspaces with weight >= 2 and N k^2 <= 1000 (for comparing
newform orbits computed by the Sagebrush engine)."""
import json, psycopg
conn = dict(host='devmirror.lmfdb.xyz', port=5432, dbname='lmfdb', user='lmfdb', password='lmfdb', connect_timeout=20)
cols = ["label", "level", "weight", "char_orbit_index", "char_order", "char_conductor", "char_values", "dim", "hecke_orbit_dims", "cusp_dim", "eis_dim", "eis_new_dim", "mf_dim"]
import sys
BOUND = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
with open(f"mf_newspaces_wt2plus_Nk2le{BOUND}.jsonl", "w") as out, psycopg.connect(**conn) as c:
    for w in range(2, int(BOUND ** 0.5) + 2):
        rows = c.execute(f"select {', '.join(cols)} from mf_newspaces where weight = %s and level*weight*weight <= %s order by level, char_orbit_index", (w, BOUND)).fetchall()
        for r in rows:
            out.write(json.dumps(dict(zip(cols, r))) + "\n")
