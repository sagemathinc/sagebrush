#!/usr/bin/env python3
"""The shard driver: one harness run across spot VMs (design: harness PR 3).

It runs in the project. It reserves, creates, checks and deletes VMs only
through the project's VM tool, sbvm.py (--sbvm; argv, never a shell), under a plan
approved by its sha256, and inside a VM-hour envelope that
counts every VM from its reservation, retries and preemptions included. It
sends each VM a git archive of the plan's commit, builds there once, then
has the VM measure one point at a time. It fetches each point's file,
bounded while streaming, checks it, and accepts it (fsync, rename, directory
fsync, then the ledger line) before that VM starts its next point.

State lives in a run directory:
  plan.json        the approved plan (its sha256 is in the bootstrap line)
  ledger.jsonl     append-only, every line fsynced before the action it
                   announces; the only state for billing and VM lifecycle
  rows/<type>/     accepted points (authoritative for "done"), and the
                   type's identity.json
  incoming/<type>/ partial transfers (never read as results)
  lock             held (flock) for the driver's whole life

  python3 bench/core/shard.py plan RUN_DIR --types TYPES.json [--envelope H]
  python3 bench/core/shard.py run RUN_DIR --sbvm PATH/sbvm.py [--repair-tail]

SIGINT and SIGTERM stop it cleanly: no new reservation or point, the
remote commands in flight are cut, every worker is joined, then every VM
proven to be this run's is deleted, and only then is the lock released.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
NAME_RE = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
RUNID_RE = re.compile(r"^[0-9a-f]{16}$")
TYPE_RE = re.compile(r"^[a-z][a-z0-9]{0,11}$")
TOKEN_RE = re.compile(r"^[a-z0-9_]{1,64}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
SIDECAR = re.compile(rb"^[0-9a-fA-F]{64}\n?$")
# Bounds on what a VM may send: a point's file, and its checksum sidecar
MAX_ROW = 1 << 20
MAX_SIDECAR = 66
TRANSFER_TIMEOUT = 60.0
TRANSFER_TRIES = 3
# The statuses a point's file may end with (terminal records: only "ok"
# yields timings)
TERMINAL = {"ok", "mismatch", "input mismatch", "no answer", "timeout", "oom", "error"}


class Fatal(Exception):
    """The run stops here: nothing more is created or started; live VMs
    are deleted on the way out."""


# ------------------------------------------------------------------ plan


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def plan_sha(plan: dict) -> str:
    return hashlib.sha256(canonical(plan)).hexdigest()


def validate_plan(plan: dict) -> None:
    """Refuse a malformed plan before anything uses it."""

    def need(cond, what):
        if not cond:
            raise Fatal("plan: " + what)

    need(
        RUNID_RE.match(str(plan.get("run_id", ""))),
        "run_id must be 16 lowercase hex digits",
    )
    need(
        re.match(r"^[0-9a-f]{40}$", str(plan.get("commit", ""))),
        "commit must be a full sha1",
    )
    need(
        HEX64.match(str(plan.get("archive_sha256", ""))),
        "archive_sha256 must be 64 hex digits",
    )
    need(
        isinstance(plan.get("envelope_hours"), (int, float))
        and plan["envelope_hours"] > 0,
        "envelope_hours > 0",
    )
    need(
        isinstance(plan.get("t_create_s"), (int, float))
        and 60 <= plan["t_create_s"] <= 3600,
        "t_create_s in [60, 3600]",
    )
    types = plan.get("types")
    need(isinstance(types, dict) and types, "types")
    for tk, t in types.items():
        need(TYPE_RE.match(tk), f"type key {tk!r}")
        need(NAME_RE.match(str(t.get("machine_type", ""))), f"{tk}: machine_type")
        need(
            t.get("zones") and all(NAME_RE.match(z) for z in t["zones"]), f"{tk}: zones"
        )
        need(
            re.match(r"^[a-z][a-z0-9-]{0,62}$", str(t.get("image", ""))), f"{tk}: image"
        )
        need(isinstance(t.get("vms"), int) and t["vms"] >= 1, f"{tk}: vms")
        need(
            isinstance(t.get("hours"), (int, float)) and 0 < t["hours"] <= 24,
            f"{tk}: hours",
        )
        need(
            isinstance(t.get("expected_build_hours"), (int, float)),
            f"{tk}: expected_build_hours",
        )
    points = plan.get("points")
    need(isinstance(points, list) and points, "points")
    for p in points:
        row, _, size = str(p).partition(":")
        need(TOKEN_RE.match(row) and size in ("s", "m", "l"), f"point {p!r}")
    exp = plan.get("expected_inputs")
    need(
        isinstance(exp, dict) and all(p in exp for p in points),
        "expected_inputs must cover every point",
    )


# ------------------------------------------------------------------ ledger


class Ledger:
    """Append-only JSONL: each line is fsynced before the action it
    announces. A torn last line (no newline, or not JSON) makes the driver
    refuse to start; --repair-tail moves exactly those bytes aside. A write
    or fsync that fails (a short write that can't be completed, ENOSPC)
    is Fatal before the action, and the ledger takes no more lines."""

    def __init__(self, path: Path, clock=time.time):
        self.path, self.clock = path, clock
        self.events: list[dict] = []
        self.lock = threading.Lock()
        self.broken = False
        new = not path.exists()
        data = b"" if new else path.read_bytes()
        if data and not data.endswith(b"\n"):
            raise Fatal(
                f"{path}: the last line is torn (no newline); run with --repair-tail"
            )
        for i, line in enumerate(data.splitlines()):
            try:
                ev = json.loads(line)
                assert isinstance(ev, dict) and "ev" in ev
            except (ValueError, AssertionError):
                raise Fatal(
                    f"{path}: line {i + 1} is not a ledger event; refusing"
                ) from None
            self.events.append(ev)
        self.fd = os.open(
            path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o644
        )
        if new:
            os.fsync(self.fd)
            fsync_dir(path.parent)

    def append(self, ev: dict) -> dict:
        ev = dict(ev, t=ev.get("t", self.clock()))
        line = memoryview(json.dumps(ev, sort_keys=True).encode() + b"\n")
        with self.lock:
            if self.broken:
                raise Fatal("the ledger had a failed write; nothing more is recorded")
            try:
                while line:
                    n = os.write(self.fd, line)
                    if n <= 0:
                        raise OSError("the write made no progress")
                    line = line[n:]
                os.fsync(self.fd)
            except OSError as e:
                self.broken = True
                raise Fatal(
                    f"ledger write failed ({e}): the action it announced is not taken"
                    " (a torn last line is refused at the next start; --repair-tail)"
                ) from None
            self.events.append(ev)
        return ev

    @staticmethod
    def repair_tail(path: Path) -> int:
        """Move a torn last line to <ledger>.torn (kept); the bytes moved."""
        data = path.read_bytes()
        cut = data.rfind(b"\n") + 1
        torn = data[cut:]
        if not torn:
            return 0
        with open(str(path) + ".torn", "ab") as f:
            f.write(torn)
            f.flush()
            os.fsync(f.fileno())
        with open(path, "r+b") as f:
            f.truncate(cut)
            f.flush()
            os.fsync(f.fileno())
        return len(torn)


# ------------------------------------------------------------------ accounting


def vm_states(events: list[dict]) -> dict:
    """Per reserved VM name: its reservation, creation, end and state
    ("unknown", "live", "deleted", "absent"). "absent" means only that no
    VM of the name was seen once its create window had passed: the create
    may have made a VM that was preempted before anyone saw it, or may
    still complete, so it proves nothing about billing."""
    vms: dict[str, dict] = {}
    for ev in events:
        name = ev.get("name")
        if ev["ev"] == "reserve":
            vms[name] = {
                "reserved": ev["t"],
                "max_run_s": ev["max_run_s"],
                "t_create_s": ev["t_create_s"],
                "type": ev["type"],
                "zone": ev["zone"],
                "state": "unknown",
            }
        elif name in vms:
            v = vms[name]
            if ev["ev"] == "created":
                v["created"] = ev["creation"]
                if v["state"] in ("unknown", "absent"):
                    v["state"] = "live"
            elif ev["ev"] == "deleted":
                v["state"], v["end"] = "deleted", ev["t"]
            elif ev["ev"] == "absent":
                v["state"], v["end"] = "absent", ev["t"]
    return vms


def charged_hours(events: list[dict], now: float) -> float:
    """Consumed plus outstanding VM-hours (draft-3 accounting): a VM counts
    from min(reservation, creation); a deleted one until its confirmed
    deletion (at most its expiry); an expired one its full lifetime; a live
    one its full remaining reservation. One whose creation was never
    observed (unknown, or absent after its window) counts maxRunDuration +
    T_create, for good: a VM it made may have run and been preempted
    unseen, or may appear late, and either bills at most maxRunDuration
    from its own creation. Nothing is ever refunded for not being seen."""
    total = 0.0
    for v in vm_states(events).values():
        start = min(v["reserved"], v.get("created", v["reserved"]))
        if "created" not in v:
            total += v["max_run_s"] + v["t_create_s"]
            continue
        expiry = v["created"] + v["max_run_s"]
        if v["state"] == "deleted":
            total += min(v["end"], expiry) - start
        else:
            total += expiry - start
    return total / 3600.0


def unknown_vms(events: list[dict]) -> list[str]:
    return sorted(n for n, v in vm_states(events).items() if v["state"] == "unknown")


def can_reserve(events: list[dict], plan: dict, hours: float, now: float) -> bool:
    """A new VM of `hours` fits the envelope, and no earlier reservation is
    still unresolved (an unknown outcome blocks all spending)."""
    if unknown_vms(events):
        return False
    need = hours + plan["t_create_s"] / 3600.0
    return charged_hours(events, now) + need <= plan["envelope_hours"] + 1e-9


# ------------------------------------------------------------------ acceptance


def fsync_dir(d: Path) -> None:
    fd = os.open(d, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def make_dirs(d: Path) -> None:
    """mkdir -p, with each new directory's entry fsynced in its parent (a
    rename's directory fsync persists entries in that directory, not the
    directory's own link)."""
    missing = []
    while not d.is_dir():
        missing.append(d)
        d = d.parent
    for m in reversed(missing):
        try:
            m.mkdir()
        except FileExistsError:
            pass
        fsync_dir(m.parent)


def check_row(
    data: bytes, sidecar: bytes, key: str, plan: dict, n: int
) -> tuple[str, dict]:
    """(sha256, record) of a received point, or Fatal: the bounds, the
    sidecar, the checksum, the JSON, the schema and identity, then the key
    (in that order; nothing is parsed before its bound is checked)."""
    if len(data) > MAX_ROW:
        raise Fatal(f"{key}: {len(data)} bytes, over {MAX_ROW}")
    if len(sidecar) > MAX_SIDECAR or not SIDECAR.match(sidecar):
        raise Fatal(f"{key}: the checksum sidecar is malformed")
    sha = hashlib.sha256(data).hexdigest()
    if sha != sidecar.strip().decode().lower():
        raise Fatal(f"{key}: checksum mismatch")
    try:
        rec = json.loads(data)
    except ValueError:
        raise Fatal(f"{key}: not JSON") from None
    if not isinstance(rec, dict):
        raise Fatal(f"{key}: not a JSON object")
    row, _, size = key.partition(":")
    want = {
        "row": row,
        "size": size,
        "n": n,
        "commit": plan["commit"],
        "complete": True,
    }
    for k, v in want.items():
        if rec.get(k) != v:
            raise Fatal(f"{key}: {k} is {rec.get(k)!r}, expected {v!r}")
    if rec.get("status") not in TERMINAL:
        raise Fatal(f"{key}: status {rec.get('status')!r} is not a terminal status")
    exp = plan["expected_inputs"][key]["input_hash"]
    if rec.get("expected_input_hash") != exp:
        raise Fatal(
            f"{key}: the VM checked inputs against {rec.get('expected_input_hash')!r}, not the plan's {exp}"
        )
    if rec["status"] == "ok" and str(rec.get("input_hash")) != exp:
        raise Fatal(
            f"{key}: an ok point with input hash {rec.get('input_hash')} != the plan's {exp}"
        )
    for k in ("machine", "versions", "artifacts", "build", "engine_pin", "backends"):
        if not isinstance(rec.get(k), (dict, list)):
            raise Fatal(f"{key}: no {k}")
    return sha, rec


IDENTITY_KEYS = (
    "machine",
    "versions",
    "artifacts",
    "build",
    "engine_pin",
    "threads",
    "mem_cap",
    "backends",
    "protocol",
)


def identity_of(rec: dict) -> dict:
    """What every point of one machine type must share (the machine label
    and kernel included; the point's own fields excluded)."""
    out = {k: rec.get(k) for k in IDENTITY_KEYS}
    out["machine"] = {
        k: v for k, v in (rec.get("machine") or {}).items() if k != "label"
    }
    return out


class Rows:
    """rows/<type>/: the accepted points, and each type's identity."""

    def __init__(self, run_dir: Path, ledger: Ledger, plan: dict):
        self.run_dir, self.ledger, self.plan = run_dir, ledger, plan
        self.lock = threading.Lock()

    def paths(self, tk: str, key: str) -> tuple[Path, Path]:
        row, _, size = key.partition(":")
        if (
            not TYPE_RE.match(tk)
            or not TOKEN_RE.match(row)
            or size not in ("s", "m", "l")
        ):
            raise Fatal(f"bad key {tk}/{key}")
        name = f"{row}-{size}"
        return (
            self.run_dir / "rows" / tk / f"{name}.json",
            self.run_dir / "incoming" / tk / f"{name}.part",
        )

    def accepted(self) -> set[tuple[str, str]]:
        return {
            (e["type"], e["key"]) for e in self.ledger.events if e["ev"] == "accepted"
        }

    def check_identity(self, tk: str, rec: dict) -> None:
        """The first accepted point of a type sets its identity; every later
        one, from any VM of the type, must equal it. The user column's
        engine must be the pinned one."""
        if not (rec.get("engine_pin") or {}).get("ok"):
            raise Fatal(
                f"{tk}: the engine wasm is not the pinned one: the run would be unofficial"
            )
        path = self.run_dir / "rows" / tk / "identity.json"
        ident = identity_of(rec)
        if path.exists():
            if json.loads(path.read_text()) != ident:
                raise Fatal(
                    f"{tk}: a point's identity differs from the type's (another machine, toolchain or binary)"
                )
            return
        make_dirs(path.parent)
        tmp = path.with_name(".identity.json.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o644)
        with os.fdopen(fd, "wb") as f:
            f.write(canonical(ident))
            f.flush()
            os.fsync(f.fileno())
        os.rename(tmp, path)
        fsync_dir(path.parent)

    def accept(
        self, tk: str, key: str, n: int, data: bytes, sidecar: bytes, vm: str
    ) -> str:
        """Check and accept one received point: the .part file is written
        (O_EXCL, no symlinks) and fsynced, renamed into rows/<type>/, the
        directory fsynced, then the ledger's accepted line. An identical
        file already accepted is acknowledged again; a different one is
        quarantined and fatal."""
        sha, rec = check_row(data, sidecar, key, self.plan, n)
        with self.lock:
            dest, part = self.paths(tk, key)
            if dest.exists():
                if hashlib.sha256(dest.read_bytes()).hexdigest() == sha:
                    if (tk, key) not in self.accepted():
                        self.ledger.append(
                            {
                                "ev": "accepted",
                                "type": tk,
                                "key": key,
                                "sha256": sha,
                                "name": vm,
                            }
                        )
                    return sha
                self.quarantine(tk, key, data, sha)
                raise Fatal(
                    f"{tk}/{key}: a different file is already accepted; the new one is quarantined"
                )
            self.check_identity(tk, rec)
            make_dirs(part.parent)
            make_dirs(dest.parent)
            if part.exists() or part.is_symlink():
                part.unlink()
            fd = os.open(
                part, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644
            )
            with os.fdopen(fd, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.rename(part, dest)
            fsync_dir(dest.parent)
            self.ledger.append(
                {"ev": "accepted", "type": tk, "key": key, "sha256": sha, "name": vm}
            )
        return sha

    def quarantine(self, tk: str, key: str, data: bytes, sha: str) -> None:
        q = self.run_dir / "rows" / tk / ".conflict"
        make_dirs(q)
        p = q / f"{key.replace(':', '-')}-{sha[:16]}.json"
        if not p.exists():
            fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            with os.fdopen(fd, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())

    def recover(self, sizes: dict) -> int:
        """At every start, before anything counts as done. Each acknowledged
        point must still be its file, with the acknowledged sha256, and pass
        every acceptance check again (schema, engine pin, the type's
        identity); one that is missing, changed or failing is Fatal (never
        counted, never silently measured again). Then, after a crash between
        a rename and its ledger line: every file in rows/<type>/ without an
        accepted line goes through the same checks and is adopted (its key
        and sha256), never measured again; one that fails them is
        quarantined and fatal. Partial .part files are removed."""
        acks = {}
        for e in self.ledger.events:
            if e["ev"] == "accepted":
                acks[(e["type"], e["key"])] = e["sha256"]
        for (tk, key), sha in sorted(acks.items()):
            dest, _ = self.paths(tk, key)
            if dest.is_symlink() or not dest.is_file():
                raise Fatal(
                    f"recovery: {tk}/{key} is acknowledged but its file is missing;"
                    " refusing to count it or measure it again"
                )
            data = dest.read_bytes()
            if hashlib.sha256(data).hexdigest() != sha:
                raise Fatal(f"recovery: {tk}/{key} changed after it was acknowledged")
            try:
                _, rec = check_row(data, sha.encode(), key, self.plan, sizes[key])
                self.check_identity(tk, rec)
            except (Fatal, KeyError) as e:
                raise Fatal(
                    f"recovery: acknowledged {tk}/{key} fails its checks ({e})"
                ) from None
        done = set(acks)
        adopted = 0
        for tdir in sorted((self.run_dir / "rows").glob("*")):
            if not tdir.is_dir() or not TYPE_RE.match(tdir.name):
                continue
            for f in sorted(tdir.glob("*.json")):
                if f.name == "identity.json":
                    continue
                row, _, size = f.stem.rpartition("-")
                key = f"{row}:{size}"
                if (tdir.name, key) in done:
                    continue
                data = f.read_bytes()
                try:
                    sha, rec = check_row(
                        data,
                        hashlib.sha256(data).hexdigest().encode(),
                        key,
                        self.plan,
                        sizes[key],
                    )
                    self.check_identity(tdir.name, rec)
                except (Fatal, KeyError) as e:
                    self.quarantine(
                        tdir.name, key, data, hashlib.sha256(data).hexdigest()
                    )
                    f.unlink()
                    raise Fatal(
                        f"recovery: {tdir.name}/{f.name} fails its checks ({e}); quarantined"
                    ) from None
                self.ledger.append(
                    {
                        "ev": "accepted",
                        "type": tdir.name,
                        "key": key,
                        "sha256": sha,
                        "name": "recovered",
                    }
                )
                adopted += 1
        for part in (self.run_dir / "incoming").glob("*/*.part"):
            part.unlink()
        return adopted


# ------------------------------------------------------------------ lock


def take_lock(run_dir: Path):
    """The run's exclusive lock, held for the driver's whole life (D1): a
    second driver on the same run exits without touching anything."""
    fd = os.open(run_dir / "lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise Fatal(f"{run_dir}: another driver holds this run") from None
    return fd


# ------------------------------------------------------------------ the VM tool


class ListError(Fatal):
    """The VMs under the run's prefix could not be listed."""


class ProviderError(Exception):
    """A VM-tool call failed or timed out: its outcome is unknown, never a
    proof of anything."""


class Sbvm:
    """The project's VM tool (sbvm.py), called with argv lists only (no
    shell). It creates every VM with no service account and the labels
    owner=sagebrush, purpose=bench and bench-run=<run id>."""

    def __init__(self, run_id: str, tool: Path, python: str = sys.executable):
        if not RUNID_RE.match(run_id):
            raise Fatal("bad run id")
        self.run_id, self.tool, self.python = run_id, tool, python

    def _run(self, argv: list[str], timeout: float) -> subprocess.CompletedProcess:
        try:
            return subprocess.run(
                [self.python, "-I", str(self.tool), *argv],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            raise ProviderError(f"sbvm {argv[0]}: timed out") from None

    def create(
        self,
        name: str,
        machine_type: str,
        zone: str,
        image: str,
        hours: float,
        timeout: float,
    ) -> None:
        for x in (name, machine_type, zone, image):
            if not NAME_RE.match(x):
                raise Fatal(f"refusing to pass {x!r} to sbvm")
        r = self._run(
            [
                "create",
                name,
                "--type",
                machine_type,
                "--zone",
                zone,
                "--image",
                image,
                "--hours",
                repr(float(hours)),
                "--purpose",
                "bench",
                "--label",
                f"bench-run={self.run_id}",
            ],
            timeout,
        )
        if r.returncode != 0:
            raise ProviderError(
                f"sbvm create {name}: exit {r.returncode}: {(r.stdout + r.stderr)[-300:]}"
            )

    def show(self, name: str) -> dict | None:
        if not NAME_RE.match(name):
            raise Fatal(f"bad name {name!r}")
        r = self._run(["show", name], 120)
        if r.returncode == 3:
            return None
        if r.returncode != 0:
            raise ProviderError(f"sbvm show {name}: exit {r.returncode}")
        return json.loads(r.stdout)

    def names(self, prefix: str) -> list[dict]:
        if not NAME_RE.match(prefix):
            raise Fatal(f"bad prefix {prefix!r}")
        r = self._run(["names", prefix], 120)
        if r.returncode != 0:
            raise ProviderError(f"sbvm names: exit {r.returncode}")
        return json.loads(r.stdout)

    def delete(self, name: str) -> None:
        if not NAME_RE.match(name):
            raise Fatal(f"bad name {name!r}")
        r = self._run(["delete", name], 600)
        if r.returncode != 0 and "no such instance" not in r.stdout + r.stderr:
            raise ProviderError(f"sbvm delete {name}: exit {r.returncode}")


def creation_time(inst: dict) -> float:
    from datetime import datetime

    return datetime.fromisoformat(inst["creationTimestamp"]).timestamp()


def ownership_problems(inst: dict, v: dict, plan: dict) -> list[str]:
    """Why a listed VM is not exactly the one this ledger reserved (S7), or
    has a service account (S6). Empty: it is ours, as reserved. Once its
    creation is recorded, the creation time must be that one (a VM made
    again under the name is not ours)."""
    t = plan["types"][v["type"]]
    sched = inst.get("scheduling") or {}
    out = []
    if inst.get("labels") != {
        "owner": "sagebrush",
        "purpose": "bench",
        "bench-run": plan["run_id"],
    }:
        out.append(f"labels {inst.get('labels')}")
    if inst.get("machineType") != t["machine_type"]:
        out.append(f"machine type {inst.get('machineType')}")
    if inst.get("zone") != v["zone"]:
        out.append(f"zone {inst.get('zone')}")
    if not str(inst.get("sourceImage") or "").endswith("/images/" + t["image"]):
        out.append(f"image {inst.get('sourceImage')}")
    if (
        sched.get("provisioningModel") != "SPOT"
        or sched.get("instanceTerminationAction") != "DELETE"
    ):
        out.append("not a self-deleting spot VM")
    if int((sched.get("maxRunDuration") or {}).get("seconds", -1)) != int(
        v["max_run_s"]
    ):
        out.append(f"maxRunDuration {sched.get('maxRunDuration')}")
    if inst.get("serviceAccounts"):
        out.append(f"service accounts {inst['serviceAccounts']}")
    try:
        c = creation_time(inst)
        if c < v["reserved"] - 120:
            out.append("created before its reservation")
        if "created" in v and c != v["created"]:
            out.append(f"creation {c}, not the recorded {v['created']}")
    except (KeyError, ValueError, TypeError):
        out.append("no creation time")
    return out


def only_service_accounts(probs: list[str]) -> bool:
    return all(p.startswith("service accounts") for p in probs)


# ------------------------------------------------------------------ the remote side


class TransferError(Exception):
    """A copy from a VM failed or exceeded its bound."""


class Ssh:
    """Commands and bounded transfers to a VM, by its IP. Remote commands are
    fixed words, each shell-quoted; remote paths come from the requested
    point, never from the VM."""

    def __init__(self, run_dir: Path, cancel: threading.Event | None = None):
        self.cancel = cancel or threading.Event()
        self.opts = [
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            f"UserKnownHostsFile={run_dir / 'known_hosts'}",
            "-o",
            "ConnectTimeout=20",
        ]

    def _target(self, ip: str) -> str:
        if not re.match(r"^\d{1,3}(\.\d{1,3}){3}$", ip or ""):
            raise TransferError(f"bad address {ip!r}")
        return f"user@{ip}"

    def _call(self, cmd: list[str], timeout: float) -> dict:
        """cmd in its own process group: ok, error, timeout or cancelled
        (the driver stopping), and the last 64 KiB of its output. The group
        is killed on every way out."""
        import signal
        import tempfile

        with tempfile.TemporaryFile() as out:
            p = subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            status, deadline = None, time.monotonic() + timeout
            try:
                while True:
                    try:
                        p.wait(timeout=0.25)
                        break
                    except subprocess.TimeoutExpired:
                        if self.cancel.is_set():
                            status = "cancelled"
                            break
                        if time.monotonic() > deadline:
                            status = "timeout"
                            break
            finally:
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                p.wait()
            out.seek(0, os.SEEK_END)
            out.seek(max(0, out.tell() - 65536))
            text = out.read().decode(errors="replace")
        if status is None:
            status = "ok" if p.returncode == 0 else "error"
        return {"status": status, "exit": p.returncode, "output": text}

    def run(self, ip: str, words: list[str], timeout: float) -> dict:
        cmd = [
            "ssh",
            *self.opts,
            self._target(ip),
            " ".join(shlex.quote(w) for w in words),
        ]
        return self._call(cmd, timeout)

    def push(self, ip: str, local: Path, remote_name: str, timeout: float) -> None:
        if not TOKEN_RE.match(remote_name.replace(".", "_").replace("-", "_")):
            raise TransferError(f"bad remote name {remote_name!r}")
        r = self._call(
            ["scp", "-q", *self.opts, str(local), f"{self._target(ip)}:{remote_name}"],
            timeout,
        )
        if r["status"] != "ok":
            raise TransferError(f"scp {r['status']} (exit {r['exit']})")

    def fetch(self, ip: str, path: str, max_bytes: int, timeout: float) -> bytes:
        """At most max_bytes from `cat -- path` on the VM; more is an error,
        and the transfer is cut at max_bytes + 1."""
        import select
        import signal

        cmd = ["ssh", *self.opts, self._target(ip), "cat -- " + shlex.quote(path)]
        p = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        buf, deadline = bytearray(), time.monotonic() + timeout
        try:
            while True:
                if self.cancel.is_set():
                    raise TransferError(f"{path}: cancelled")
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TransferError(f"{path}: timed out")
                ready, _, _ = select.select([p.stdout], [], [], min(left, 0.25))
                if not ready:
                    continue
                # (never more than one byte past the bound in memory)
                chunk = os.read(p.stdout.fileno(), min(65536, max_bytes + 1 - len(buf)))
                if not chunk:
                    break
                buf += chunk
                if len(buf) > max_bytes:
                    raise TransferError(f"{path}: more than {max_bytes} bytes")
            if p.wait(timeout=max(1.0, deadline - time.monotonic())) != 0:
                raise TransferError(f"{path}: exit {p.returncode}")
        finally:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            p.wait()
            p.stdout.close()
        return bytes(buf)


# ------------------------------------------------------------------ the driver


def point_sizes(plan: dict) -> dict:
    return {k: v["n"] for k, v in plan["expected_inputs"].items()}


def expected_seconds(key: str) -> float:
    """A point's expected cost, for longest-first assignment: the row's
    timeout (no earlier medians in v1)."""
    rows = json.loads((HERE / "items.json").read_text())["rows"]
    row, _, size = key.partition(":")
    for r in rows:
        if r["id"] == row:
            return float(r["sizes"][size]["timeout"])
    return 0.0


class Driver:
    """One run: bootstrap, reconcile, then per machine type its VMs, each
    measuring one point at a time, until every point is accepted, the
    envelope is spent, or something is fatal. Every VM is deleted (and the
    deletion confirmed) on the way out."""

    def __init__(
        self,
        run_dir: Path,
        provider,
        remote,
        archive: Path,
        clock=time.time,
        sleep=time.sleep,
        poll_s: float = 15.0,
        stop: threading.Event | None = None,
    ):
        self.run_dir, self.provider, self.remote, self.archive = (
            run_dir,
            provider,
            remote,
            archive,
        )
        self.clock, self.sleep, self.poll_s = clock, sleep, poll_s
        self.spend = threading.Lock()
        self.stopped: dict[str, str] = {}
        self.fatal: list[str] = []
        # (set by anything fatal and by SIGINT/SIGTERM: no new reservation,
        # setup or point after it; the remote's commands in flight are cut)
        self.stop = stop or threading.Event()

    def fail(self, msg: str) -> None:
        self.fatal.append(msg)
        self.stop.set()

    # -- start
    def bootstrap(self) -> None:
        self.plan = json.loads((self.run_dir / "plan.json").read_text())
        validate_plan(self.plan)
        sha = plan_sha(self.plan)
        self.ledger = Ledger(self.run_dir / "ledger.jsonl", self.clock)
        boot = [e for e in self.ledger.events if e["ev"] == "bootstrap"]
        if not boot:
            self.ledger.append(
                {"ev": "bootstrap", "plan_sha256": sha, "run_id": self.plan["run_id"]}
            )
        elif boot[0]["plan_sha256"] != sha:
            raise Fatal(
                f"plan.json changed after bootstrap (bootstrap {boot[0]['plan_sha256']}, now {sha})"
            )
        if (
            hashlib.sha256(self.archive.read_bytes()).hexdigest()
            != self.plan["archive_sha256"]
        ):
            raise Fatal("the payload archive is not the plan's")
        self.rows = Rows(self.run_dir, self.ledger, self.plan)
        self.prefix = f"bc-{self.plan['run_id']}-"

    def reconcile(self) -> None:
        """Every VM the provider lists under this run's prefix must be one
        this ledger reserved, exactly as reserved (labels, type, zone, image,
        lifetime, no service account, created after its reservation);
        anything else is fatal and left untouched. Reserved VMs the listing
        doesn't show are closed: deleted if they had been created, absent
        if their create window has passed."""
        try:
            listed = {i["name"]: i for i in self.provider.names(self.prefix)}
        except ProviderError as e:
            raise ListError(
                f"reconcile: cannot list VMs ({e}); nothing proven, nothing spent or deleted"
            ) from None
        states = vm_states(self.ledger.events)
        for name, inst in listed.items():
            v = states.get(name)
            if v is None or v["state"] == "deleted":
                raise Fatal(
                    f"reconcile: {name} carries this run's prefix but is not a live reservation of its ledger; untouched"
                )
            probs = ownership_problems(inst, v, self.plan)
            if probs:
                raise Fatal(
                    f"reconcile: {name} is not the VM reserved: {'; '.join(probs)}; untouched"
                )
            # (an unknown create that did make it, or an absent one whose
            # create completed late: observed now, then deleted as live)
            if v["state"] in ("unknown", "absent"):
                self.ledger.append(
                    {"ev": "created", "name": name, "creation": creation_time(inst)}
                )
        now = self.clock()
        for name, v in states.items():
            if name in listed or v["state"] in ("deleted", "absent"):
                continue
            if v["state"] == "live":
                self.ledger.append(
                    {
                        "ev": "deleted",
                        "name": name,
                        "why": "not listed (preempted or expired)",
                    }
                )
            elif now > v["reserved"] + v["t_create_s"]:
                self.ledger.append({"ev": "absent", "name": name})

    def late_creates(self) -> None:
        """Adopt any reservation recorded absent whose VM has since
        appeared (a create that completed late), so it is deleted rather
        than left to bill until its maxRunDuration."""
        states = vm_states(self.ledger.events)
        if not any(v["state"] == "absent" for v in states.values()):
            return
        try:
            listed = self.provider.names(self.prefix)
        except ProviderError:
            return
        for inst in listed:
            v = states.get(inst.get("name"))
            if (
                v
                and v["state"] == "absent"
                and not ownership_problems(inst, v, self.plan)
            ):
                self.ledger.append(
                    {
                        "ev": "created",
                        "name": inst["name"],
                        "creation": creation_time(inst),
                    }
                )
                self.delete(inst["name"])

    # -- VMs
    def new_vm(self, tk: str) -> dict | None:
        """Reserve, create and verify one VM of type tk, or None when the
        envelope forbids it (a create proven never to have happened is
        followed by another attempt, while the envelope allows)."""
        while True:
            vm = self._new_vm(tk)
            if vm != "absent":
                return vm

    def _new_vm(self, tk: str):
        t = self.plan["types"][tk]
        with self.spend:
            while unknown_vms(self.ledger.events):
                if self.stop.is_set():
                    return None
                self.reconcile()
                if unknown_vms(self.ledger.events):
                    self.sleep(self.poll_s)
            self.late_creates()
            if (
                self.stop.is_set()
                or tk in self.stopped
                or not can_reserve(
                    self.ledger.events, self.plan, t["hours"], self.clock()
                )
            ):
                return None
            n = sum(
                1
                for e in self.ledger.events
                if e["ev"] == "reserve" and e["type"] == tk
            )
            name = f"{self.prefix}{tk}-{n}"
            zone = t["zones"][n % len(t["zones"])]
            self.ledger.append(
                {
                    "ev": "reserve",
                    "name": name,
                    "type": tk,
                    "zone": zone,
                    "max_run_s": int(t["hours"] * 3600),
                    "t_create_s": self.plan["t_create_s"],
                    "plan_sha256": plan_sha(self.plan),
                }
            )
            try:
                self.provider.create(
                    name,
                    t["machine_type"],
                    zone,
                    t["image"],
                    t["hours"],
                    self.plan["t_create_s"],
                )
            except ProviderError as e:
                self.ledger.append(
                    {"ev": "create-unknown", "name": name, "detail": str(e)[:300]}
                )
            # (resolved only by an exact-name read: found, or absent once
            # the create window has passed; absent is still charged in full.
            # This runs to its end even when stopping: the create is in
            # flight, and what it made must be recorded to be deleted)
            deadline = self.ledger.events[-1]["t"] + self.plan["t_create_s"]
            while True:
                try:
                    inst = self.provider.show(name)
                except ProviderError as e:
                    if self.clock() > deadline:
                        raise Fatal(
                            f"{name}: its create's outcome can't be read ({e});"
                            " it stays unknown and charged in full"
                        ) from None
                    inst = None
                if isinstance(inst, dict):
                    break
                if self.clock() > deadline:
                    self.ledger.append({"ev": "absent", "name": name})
                    return "absent"
                self.sleep(self.poll_s)
            v = vm_states(self.ledger.events)[name]
            probs = ownership_problems(inst, v, self.plan)
            if probs and not only_service_accounts(probs):
                raise Fatal(
                    f"{name}: not the VM reserved ({'; '.join(probs)}); untouched,"
                    " and its reservation stays charged in full"
                )
            self.ledger.append(
                {"ev": "created", "name": name, "creation": creation_time(inst)}
            )
            if probs:
                self.delete(name)
                raise Fatal(f"{name}: created but not as reserved: {'; '.join(probs)}")
            return {"name": name, "type": tk, "ip": inst.get("ip")}

    def delete(self, name: str) -> None:
        """Delete one VM this ledger reserved, and confirm it by an exact-name
        read; only then is billing closed. Before every delete request, an
        exact-name read must show the VM is the one reserved: every
        ownership field (labels, type, zone, image, scheduling, lifetime,
        and the recorded creation time once there is one). A service
        account alone doesn't block it (everything else proves it ours).
        Anything else, or a read that fails, is never deleted: it is
        reported, and its maxRunDuration bounds it if it is ours."""
        asked = False
        for _ in range(20):
            v = vm_states(self.ledger.events).get(name)
            if v is None:
                self.fail(f"{name}: not a reservation of this ledger; untouched")
                return
            try:
                inst = self.provider.show(name)
            except ProviderError:
                self.sleep(self.poll_s)
                continue
            if inst is None:
                if v["state"] == "live":
                    self.ledger.append({"ev": "deleted", "name": name})
                # (an unknown or absent one stays charged in full)
                return
            probs = ownership_problems(inst, v, self.plan)
            if probs and not only_service_accounts(probs):
                self.fail(
                    f"{name}: not deleted: not provably the VM reserved"
                    f" ({'; '.join(probs)}); untouched"
                )
                return
            if "created" not in v:
                self.ledger.append(
                    {"ev": "created", "name": name, "creation": creation_time(inst)}
                )
            if not asked:
                self.ledger.append({"ev": "delete-requested", "name": name})
                asked = True
            try:
                self.provider.delete(name)
            except ProviderError:
                self.sleep(self.poll_s)
        self.fail(f"{name}: deletion not confirmed; it ends by its maxRunDuration")

    def alive(self, vm: dict) -> bool:
        try:
            return self.provider.show(vm["name"]) is not None
        except ProviderError:
            return True

    # -- per VM
    def setup(self, vm: dict) -> bool:
        """The payload and the build, once per VM; its wall time goes in the
        ledger. A failed build stops the type (the same commit fails the
        same way)."""
        t0 = self.clock()
        want = self.plan["archive_sha256"]
        try:
            # (the approved bytes: checked here just before the copy, and on
            # the VM after it, before anything is extracted)
            if hashlib.sha256(self.archive.read_bytes()).hexdigest() != want:
                raise Fatal("payload.tar changed after its approval")
            self.remote.push(vm["ip"], self.archive, "payload.tar", 600)
            r = self.remote.run(vm["ip"], ["sha256sum", "--", "payload.tar"], 300)
            got = (r.get("output") or "").split()[:1]
            if r["status"] == "ok" and got != [want]:
                raise Fatal(
                    f"{vm['name']}: the uploaded payload's sha256 is {got}, not the plan's {want}"
                )
            if r["status"] != "ok":
                raise TransferError(f"sha256sum {r['status']}")
            r = self.remote.run(
                vm["ip"],
                [
                    "bash",
                    "-c",
                    f"echo '{want}  payload.tar' | sha256sum -c --status -"
                    " && mkdir -p sb && tar -xf payload.tar -C sb && bash sb/bench/core/vm-setup.sh",
                ],
                self.plan["types"][vm["type"]]["expected_build_hours"] * 3600 * 2 + 600,
            )
            ok = r["status"] == "ok"
        except TransferError as e:
            ok, r = False, {"output": str(e)}
        self.ledger.append(
            {
                "ev": "build",
                "name": vm["name"],
                "seconds": round(self.clock() - t0, 1),
                "ok": ok,
            }
        )
        if not ok and not self.stop.is_set() and self.alive(vm):
            self.stopped[vm["type"]] = (
                f"the build failed on {vm['name']}: {str(r.get('output', ''))[-300:]}"
            )
        return ok

    def measure(self, vm: dict, key: str) -> None:
        """One point on one VM, then its file fetched (bounded), checked and
        accepted before the VM gets another."""
        row, _, size = key.partition(":")
        tk = vm["type"]
        timeout = expected_seconds(key) * 12 + 600
        r = self.remote.run(
            vm["ip"],
            [
                "bash",
                "sb/bench/core/cgroup-setup.sh",
                "python3",
                "sb/bench/core/run.py",
                "--only",
                row,
                "--sizes",
                size,
                "--host-label",
                tk,
                "--out",
                "out",
                "--expected-inputs",
                "sb/expected-inputs.json",
            ],
            timeout,
        )
        if r["status"] != "ok":
            raise TransferError(
                f"{key} on {vm['name']}: run.py {r['status']} {str(r.get('output', ''))[-300:]}"
            )
        name = f"out/rows/{row}-{size}.json"
        for attempt in range(TRANSFER_TRIES):
            try:
                data = self.remote.fetch(vm["ip"], name, MAX_ROW, TRANSFER_TIMEOUT)
                side = self.remote.fetch(
                    vm["ip"], name + ".sha256", MAX_SIDECAR, TRANSFER_TIMEOUT
                )
                break
            except TransferError:
                if attempt == TRANSFER_TRIES - 1:
                    raise
        self.rows.accept(tk, key, point_sizes(self.plan)[key], data, side, vm["name"])

    def worker(self, tk: str, queue: list[str]) -> None:
        vm = None
        try:
            while not self.stop.is_set() and tk not in self.stopped:
                with self.spend:
                    if not queue:
                        return
                if vm is None:
                    vm = self.new_vm(tk)
                    if vm is None:
                        return
                    if self.stop.is_set():
                        continue
                    if not self.setup(vm):
                        if tk in self.stopped or self.stop.is_set():
                            return
                        # (the VM went away during its build: a new one)
                        self.ledger.append(
                            {"ev": "lost", "name": vm["name"], "point": None}
                        )
                        self.reconcile()
                        vm = None
                        continue
                with self.spend:
                    if not queue or self.stop.is_set():
                        return
                    key = queue.pop(0)
                try:
                    self.measure(vm, key)
                except (TransferError, ProviderError) as e:
                    with self.spend:
                        queue.insert(0, key)
                    if self.stop.is_set():
                        return
                    if not self.alive(vm):
                        self.ledger.append(
                            {
                                "ev": "lost",
                                "name": vm["name"],
                                "point": key,
                                "detail": str(e)[:200],
                            }
                        )
                        self.reconcile()
                        vm = None
                    else:
                        self.delete(vm["name"])
                        self.ledger.append(
                            {
                                "ev": "retired",
                                "name": vm["name"],
                                "point": key,
                                "detail": str(e)[:200],
                            }
                        )
                        vm = None
        except Fatal as e:
            self.fail(str(e))
        except Exception as e:
            self.fail(f"{tk} worker: {type(e).__name__}: {e}")
        finally:
            try:
                if vm is not None and vm["name"] in {
                    n
                    for n, v in vm_states(self.ledger.events).items()
                    if v["state"] == "live"
                }:
                    self.delete(vm["name"])
            except Exception as e:
                self.fail(f"{tk} worker cleanup: {type(e).__name__}: {e}")

    def cleanup(self) -> None:
        """After every worker has ended: list again, then delete every VM
        of this ledger not proven closed (live, unknown, absent), each only
        after its own exact-name ownership proof. Without a listing nothing
        is deleted (nothing is proven), and an untrusted plan (bootstrap not
        finished) deletes nothing either."""
        if not hasattr(self, "rows"):
            return
        try:
            self.reconcile()
        except ListError as e:
            self.fail(f"cleanup: {e}")
            return
        except Fatal as e:
            self.fail(f"cleanup: {e}")
        for name, v in vm_states(self.ledger.events).items():
            if v["state"] in ("live", "unknown", "absent"):
                try:
                    self.delete(name)
                except Exception as e:
                    self.fail(f"cleanup {name}: {type(e).__name__}: {e}")

    def run(self) -> dict:
        import signal

        lock = take_lock(self.run_dir)
        threads: list[threading.Thread] = []
        old = {}
        if threading.current_thread() is threading.main_thread():
            for sig in (signal.SIGINT, signal.SIGTERM):
                old[sig] = signal.signal(
                    sig, lambda s, _f: self.fail(f"stopped by signal {s}")
                )
        try:
            self.bootstrap()
            self.rows.recover(point_sizes(self.plan))
            self.reconcile()
            # (a VM adopted from an earlier driver has an unknown build and
            # point state: it is deleted, confirmed, before anything new is
            # created, so it bills no longer than it must)
            for name, v in vm_states(self.ledger.events).items():
                if v["state"] == "live":
                    self.delete(name)
            done = self.rows.accepted()
            for tk, t in self.plan["types"].items():
                queue = sorted(
                    (k for k in self.plan["points"] if (tk, k) not in done),
                    key=lambda k: -expected_seconds(k),
                )
                for _ in range(t["vms"]):
                    if self.stop.is_set():
                        break
                    th = threading.Thread(target=self.worker, args=(tk, queue))
                    th.start()
                    threads.append(th)
            for th in threads:
                while th.is_alive():
                    th.join(0.25)
        except Fatal as e:
            self.fail(str(e))
        except Exception as e:
            self.fail(f"driver: {type(e).__name__}: {e}")
        finally:
            # (order: stop, join every worker, clean up, restore the
            # signal handlers, and only then release the lock)
            self.stop.set()
            for th in threads:
                while th.is_alive():
                    th.join(0.25)
            try:
                self.cleanup()
            finally:
                for sig, h in old.items():
                    signal.signal(sig, h)
                os.close(lock)
        return self.report()

    def report(self) -> dict:
        if not hasattr(self, "rows"):
            return {"fatal": self.fatal}
        done = self.rows.accepted()
        want = {(tk, k) for tk in self.plan["types"] for k in self.plan["points"]}
        return {
            "accepted": len(done & want),
            "left": sorted(f"{tk}/{k}" for tk, k in want - done),
            "charged_hours": round(charged_hours(self.ledger.events, self.clock()), 3),
            "envelope_hours": self.plan["envelope_hours"],
            "stopped_types": self.stopped,
            "fatal": self.fatal,
        }


# ------------------------------------------------------------------ plans and the command line


def make_plan(
    run_dir: Path,
    types: dict,
    envelope: float,
    points: list[str],
    t_create_s: int = 600,
) -> str:
    """A run directory ready for approval: plan.json (its sha256 printed),
    and payload.tar (a git archive of the clean HEAD, plus .bench-commit and
    expected-inputs.json). The expected inputs are computed here, in the
    project, before any VM exists."""
    import secrets
    import tarfile
    import io

    sys.path.insert(0, str(HERE))
    import expected_inputs  # noqa: E402

    def git(*a):
        return subprocess.run(
            ["git", *a], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout

    if git("status", "--porcelain").strip():
        raise Fatal("the tree is not clean: an official run measures a commit")
    commit = git("rev-parse", "HEAD").strip()
    run_dir.mkdir(parents=True, exist_ok=False)
    keys = sorted(set(points))
    sizes = sorted({k.split(":")[1] for k in keys})
    exp_all = expected_inputs.expected(sizes, sorted({k.split(":")[0] for k in keys}))
    expected = {k: exp_all[k] for k in keys}
    archive = run_dir / "payload.tar"
    subprocess.run(
        ["git", "archive", "--format=tar", "--prefix=", "-o", str(archive), commit],
        cwd=ROOT,
        check=True,
    )
    with tarfile.open(archive, "a") as tar:
        for name, text in (
            (".bench-commit", commit + "\n"),
            (
                "expected-inputs.json",
                json.dumps(expected, sort_keys=True, indent=1) + "\n",
            ),
        ):
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(data), 0o644, 0
            tar.addfile(info, io.BytesIO(data))
    plan = {
        "run_id": secrets.token_hex(8),
        "commit": commit,
        "archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "envelope_hours": envelope,
        "t_create_s": t_create_s,
        "types": types,
        "points": keys,
        "expected_inputs": expected,
    }
    validate_plan(plan)
    (run_dir / "plan.json").write_bytes(canonical(plan) + b"\n")
    return plan_sha(plan)


def main(argv: list[str]) -> int:
    import argparse

    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan", help="make a run directory for approval")
    p.add_argument("run_dir", type=Path)
    p.add_argument(
        "--types",
        type=Path,
        required=True,
        help="JSON: {type: {machine_type, zones, image, vms, hours, expected_build_hours}}",
    )
    p.add_argument("--envelope", type=float, default=18.0)
    p.add_argument(
        "--points", default="all", help="'all', or comma-separated row:size keys"
    )
    r = sub.add_parser("run", help="run an approved plan")
    r.add_argument("run_dir", type=Path)
    r.add_argument("--sbvm", type=Path, required=True, help="the VM tool, sbvm.py")
    r.add_argument("--repair-tail", action="store_true")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "plan":
            rows = json.loads((HERE / "items.json").read_text())["rows"]
            pts = (
                [f"{x['id']}:{k}" for x in rows for k in x["sizes"]]
                if a.points == "all"
                else a.points.split(",")
            )
            print(
                "plan sha256",
                make_plan(a.run_dir, json.loads(a.types.read_text()), a.envelope, pts),
            )
            return 0
        if a.repair_tail:
            print(
                "moved",
                Ledger.repair_tail(a.run_dir / "ledger.jsonl"),
                "torn bytes to ledger.jsonl.torn",
            )
        plan = json.loads((a.run_dir / "plan.json").read_text())
        stop = threading.Event()
        d = Driver(
            a.run_dir,
            Sbvm(plan["run_id"], a.sbvm),
            Ssh(a.run_dir, stop),
            a.run_dir / "payload.tar",
            stop=stop,
        )
        rep = d.run()
        print(json.dumps(rep, indent=1))
        return 1 if rep.get("fatal") else 0
    except Fatal as e:
        print("FATAL:", e, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
