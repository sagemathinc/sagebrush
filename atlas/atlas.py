"""The atlas storage layer (M0, local directory; the same layout goes to R2).

    <root>/shards/<sha256>.parquet                 immutable data (content-addressed)
    <root>/certs/<sha256>.json                     certificates
    <root>/schemas/<sha256>.json                   table schemas
    <root>/manifests/<kind>/<table>/<sha256>.json  immutable manifests
    <root>/manifests/<kind>/<table>/current.json   pointer to the latest manifest

Every row has three standard columns besides its mathematics:
    source       list of sources that produced or confirmed the row
    status       imported < computed < checked < proven, or disputed
    certificate  sha256 of the certificate describing how it was obtained
"""

import datetime, hashlib, json, os, subprocess
import pyarrow as pa
import pyarrow.parquet as pq

STATUSES = ["imported", "computed", "checked", "proven", "disputed"]


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _put_json(root, kind, obj):
    data = json.dumps(obj, indent=2, sort_keys=True).encode()
    sha = hashlib.sha256(data).hexdigest()
    path = os.path.join(root, kind, f"{sha}.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.write(data)
    return sha


def git_commit(path):
    try:
        return subprocess.run(["git", "-C", path, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip() or None
    except OSError:
        return None


def put_certificate(root, claim, method, checks, recipe):
    """Stores a certificate; returns its sha256."""
    return _put_json(root, "certs", {
        "claim": claim, "method": method, "checks": checks, "recipe": recipe,
        "created": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    })


def write_table(root, kind, table, rows, schema, key, shard_size, description):
    """Writes rows (a list of dicts with the standard columns) as Parquet
    shards partitioned by `key`, plus a manifest; returns the manifest."""
    for r in rows:
        assert r["status"] in STATUSES, r["status"]
    rows = sorted(rows, key=lambda r: r[key])
    arrow_schema = pa.schema([(c["name"], c["arrow"]) for c in schema["columns"]])
    shards = []
    os.makedirs(os.path.join(root, "shards"), exist_ok=True)
    for lo in range(0, len(rows), shard_size):
        part = rows[lo:lo + shard_size]
        tbl = pa.Table.from_pylist(part, schema=arrow_schema)
        tmp = os.path.join(root, "shards", f".tmp-{os.getpid()}.parquet")
        pq.write_table(tbl, tmp, compression="zstd")
        sha = _sha256_file(tmp)
        path = os.path.join(root, "shards", f"{sha}.parquet")
        os.replace(tmp, path)
        shards.append({"sha256": sha, "rows": len(part), "bytes": os.path.getsize(path),
                       "key": key, "key_range": [part[0][key], part[-1][key]]})
    schema_doc = {k: v for k, v in schema.items() if k != "columns"}
    schema_doc["columns"] = [{k: (str(v) if k == "arrow" else v) for k, v in c.items()} for c in schema["columns"]]
    status_counts = {s: sum(r["status"] == s for r in rows) for s in STATUSES}
    certs = sorted({r["certificate"] for r in rows if r.get("certificate")})
    manifest = {
        "kind": kind, "table": table, "description": description,
        "schema": _put_json(root, "schemas", schema_doc),
        "shards": shards, "rows": len(rows), "status_counts": status_counts, "certificates": certs,
        "builder_commit": git_commit(os.path.dirname(os.path.abspath(__file__))),
        "created": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    }
    sha = _put_json(root, os.path.join("manifests", kind, table), manifest)
    # the pointer is replaced atomically (an interrupted write never leaves
    # an unreadable current.json)
    cur = os.path.join(root, "manifests", kind, table, "current.json")
    with open(cur + ".tmp", "w") as f:
        json.dump({"manifest": sha}, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(cur + ".tmp", cur)
    return manifest


def manifest(root, kind, table, sha=None):
    if sha is None:
        sha = json.load(open(os.path.join(root, "manifests", kind, table, "current.json")))["manifest"]
    return json.load(open(os.path.join(root, "manifests", kind, table, f"{sha}.json")))


def shard_paths(root, kind, table, verify=True, sha=None):
    """Paths of a table's shards (from the current or a given manifest),
    each checked against its sha256."""
    paths = []
    for s in manifest(root, kind, table, sha)["shards"]:
        p = os.path.join(root, "shards", f"{s['sha256']}.parquet")
        if verify and _sha256_file(p) != s["sha256"]:
            raise ValueError(f"shard {p} does not match its hash")
        paths.append(p)
    return paths


def certificate(root, sha):
    return json.load(open(os.path.join(root, "certs", f"{sha}.json")))


def duckdb_view(con, root, kind, table, name=None):
    """Registers a verified table as a DuckDB view."""
    paths = shard_paths(root, kind, table)
    con.execute(f"create or replace view {name or table} as select * from read_parquet({paths!r})")
