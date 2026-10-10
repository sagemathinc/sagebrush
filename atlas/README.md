# The atlas: milestone M0

A local prototype of the agent-first LMFDB described in
[`design/lmfdb-for-agents.md`](../design/lmfdb-for-agents.md). The same
directory layout is meant to go to R2 unchanged in M1.

- `atlas.py`: the storage layer. It writes content-addressed Parquet
  shards, certificates, schemas and immutable manifests, and on read
  verifies every shard's SHA-256 before handing it to DuckDB.
- `build_m0.py`: builds the M0 tables from Sagebrush computations and an
  LMFDB mirror slice.
- `make_notebook.py`: writes and executes `demo_m0.ipynb`, the demo.

## Tables

| table | rows | contents |
|---|---|---|
| `mf/rational_newforms_wt2` | every rational weight-2 newform, $N\le 9999$ | $a_p$ ($p<1000$), LMFDB label, isogeny class; `checked` when Sagebrush, LMFDB, Cremona and point counts all agree |
| `mf/newform_orbits_wt2` | every Galois orbit of weight-2 newforms, $N\le 1000$ | dimension, Hecke polynomial, $\operatorname{tr}(a_p)$, exact integer coordinates of $a_p$ (Stein's representation after HNF+LLL; the $\beta_r\in K$ are not yet stored) |
| `ec/curves` | LMFDB's elliptic curves, conductor $\le 9999$ | curve data (imported) plus its newform, linked by point counts |
| `lmfdb/mf_newforms_wt2` | LMFDB slice: weight 2, trivial character, $N\le 9999$ | imported; `checked` where Sagebrush recomputed it |

Every row has `source`, `status` (`imported` < `computed` < `checked` <
`proven`, or `disputed`) and `certificate` (the SHA-256 of a JSON
certificate under `certs/`, with claim, method, checks and recipe).

## Rebuilding

```sh
# Sagebrush computations (engine/, release build)
cargo run --release -p sagebrush-oracle --example integral -- ~/data/atlas-src/orbits_le1000.jsonl 1-1000
cargo run --release -p sagebrush-modsym --example rational_table -- ~/data/atlas-src/rational_newforms_le9999.jsonl 11 9999
# LMFDB slice from the read-only mirror (needs psycopg)
python ~/data/lmfdb/fetch_m0.py
# Cremona's aplist: https://github.com/JohnCremona/ecdata (aplist/aplist.00000-09999)
# Build, then the demo (engine/.venv has sagebrush, pyarrow, python-flint, duckdb)
~/sagebrush/engine/.venv/bin/python build_m0.py ~/data/atlas
~/sagebrush/engine/.venv/bin/python make_notebook.py ~/data/atlas
```

## Reading

```python
import duckdb, atlas
con = duckdb.connect()
atlas.duckdb_view(con, "/path/to/atlas", "mf", "rational_newforms_wt2", "rational")
con.sql("select label, ap[1:5] from rational where level = 389").show()
```
