#!/usr/bin/env python3
"""Tests of the shard driver (shard.py) with no VM and no network: the
plan, the ledger, the VM-hour accounting, acceptance, recovery, the lock.

  python3 bench/core/test_shard.py
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import shard  # noqa: E402

H = 3600.0


def plan(**over):
    p = {
        "run_id": "0123456789abcdef",
        "commit": "a" * 40,
        "archive_sha256": "b" * 64,
        "envelope_hours": 18,
        "t_create_s": 600,
        "types": {
            "x86": {
                "machine_type": "n2-standard-16",
                "zones": ["northamerica-northeast2-a"],
                "image": "sb-base-20261112c",
                "vms": 2,
                "hours": 3,
                "expected_build_hours": 0.25,
            },
        },
        "points": ["poly_fp_mul:s"],
        "expected_inputs": {
            "poly_fp_mul:s": {"n": 1000, "variants": 8, "input_hash": "308890519"}
        },
    }
    p.update(over)
    return p


def row(**over):
    r = {
        "row": "poly_fp_mul",
        "size": "s",
        "n": 1000,
        "commit": "a" * 40,
        "complete": True,
        "status": "ok",
        "input_hash": "308890519",
        "expected_input_hash": "308890519",
        "protocol": 4,
        "machine": {
            "label": "x86",
            "cpu": "Xeon",
            "arch": "x86_64",
            "flags": ["avx2"],
            "nproc": 16,
            "kernel": "6.8",
        },
        "versions": {"node": "v24"},
        "artifacts": {"native": "c" * 64},
        "build": {"rustc": "1.99.1"},
        "engine_pin": {"ok": True},
        "backends": {},
        "threads": 16,
        "mem_cap": 1,
    }
    r.update(over)
    return r


def blob(rec):
    data = json.dumps(rec).encode()
    return data, (hashlib.sha256(data).hexdigest() + "\n").encode()


class Plans(unittest.TestCase):
    def test_a_good_plan(self):
        shard.validate_plan(plan())

    def test_bad_plans_are_refused(self):
        for over in (
            {"run_id": "XYZ"},
            {"run_id": "0123456789ABCDEF"},
            {"commit": "a" * 39},
            {"envelope_hours": 0},
            {"t_create_s": 5},
            {"points": ["poly_fp_mul:x"]},
            {"points": ["../etc:s"]},
            {"expected_inputs": {}},
            {"types": {"X86": plan()["types"]["x86"]}},
            {"types": {"x86": dict(plan()["types"]["x86"], zones=["us;rm -rf"])}},
        ):
            with self.subTest(over=over), self.assertRaises(shard.Fatal):
                shard.validate_plan(plan(**over))

    def test_the_sha_ignores_formatting_not_content(self):
        p = plan()
        self.assertEqual(
            shard.plan_sha(p), shard.plan_sha(json.loads(json.dumps(p, indent=3)))
        )
        self.assertNotEqual(shard.plan_sha(p), shard.plan_sha(plan(envelope_hours=19)))


class Ledgers(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp(prefix="shard-ledger-"))
        self.path = self.d / "ledger.jsonl"

    def tearDown(self):
        shutil.rmtree(self.d)

    def test_append_and_reload(self):
        led = shard.Ledger(self.path)
        led.append({"ev": "bootstrap", "plan": "x"})
        led.append(
            {
                "ev": "reserve",
                "name": "a",
                "max_run_s": 1,
                "t_create_s": 1,
                "type": "x86",
                "zone": "z",
            }
        )
        self.assertEqual(
            [e["ev"] for e in shard.Ledger(self.path).events], ["bootstrap", "reserve"]
        )

    def test_a_torn_tail_is_refused_then_repaired(self):
        led = shard.Ledger(self.path)
        led.append({"ev": "bootstrap"})
        with open(self.path, "ab") as f:
            f.write(b'{"ev": "reser')
        with self.assertRaises(shard.Fatal):
            shard.Ledger(self.path)
        self.assertEqual(shard.Ledger.repair_tail(self.path), 13)
        self.assertEqual(Path(str(self.path) + ".torn").read_bytes(), b'{"ev": "reser')
        self.assertEqual(
            [e["ev"] for e in shard.Ledger(self.path).events], ["bootstrap"]
        )

    def test_a_corrupt_middle_line_is_refused(self):
        self.path.write_bytes(b'{"ev": "bootstrap"}\nnot json\n{"ev": "x"}\n')
        with self.assertRaises(shard.Fatal):
            shard.Ledger(self.path)


def reserve(name, t, max_run=3 * H, t_create=600):
    return {
        "ev": "reserve",
        "name": name,
        "t": t,
        "max_run_s": max_run,
        "t_create_s": t_create,
        "type": "x86",
        "zone": "z",
    }


class Accounting(unittest.TestCase):
    def test_unknown_creation_charges_duration_plus_t_create_and_blocks(self):
        ev = [reserve("a", 0)]
        self.assertAlmostEqual(shard.charged_hours(ev, 10), 3 + 600 / H)
        self.assertEqual(shard.unknown_vms(ev), ["a"])
        self.assertFalse(shard.can_reserve(ev, plan(), 3, 10))

    def test_delayed_create_expires_from_creation(self):
        # reserved at 0, created at 300: expiry is 300 + 3 h, charged from 0
        ev = [
            reserve("a", 0),
            {"ev": "created", "name": "a", "creation": 300, "t": 301},
        ]
        self.assertAlmostEqual(shard.charged_hours(ev, 400), (300 + 3 * H) / H)
        self.assertLessEqual(shard.charged_hours(ev, 400), 3 + 600 / H)

    def test_early_delete_releases_only_the_rest(self):
        ev = [
            reserve("a", 0),
            {"ev": "created", "name": "a", "creation": 10, "t": 11},
            {"ev": "deleted", "name": "a", "t": H},
        ]
        self.assertAlmostEqual(shard.charged_hours(ev, 2 * H), 1.0)

    def test_expiry_consumes_the_full_duration(self):
        ev = [
            reserve("a", 0),
            {"ev": "created", "name": "a", "creation": 0, "t": 1},
            {"ev": "deleted", "name": "a", "t": 5 * H},
        ]
        self.assertAlmostEqual(shard.charged_hours(ev, 6 * H), 3.0)

    def test_a_preemption_and_its_replacement_are_both_charged(self):
        ev = [
            reserve("a", 0),
            {"ev": "created", "name": "a", "creation": 0, "t": 1},
            {"ev": "deleted", "name": "a", "t": H},
            reserve("b", H + 1),
            {"ev": "created", "name": "b", "creation": H + 2, "t": H + 3},
        ]
        self.assertAlmostEqual(shard.charged_hours(ev, H + 10), 1.0 + (1 + 3 * H) / H)

    def test_a_proven_absent_reservation_charges_nothing(self):
        ev = [reserve("a", 0), {"ev": "absent", "name": "a", "t": 700}]
        self.assertEqual(shard.charged_hours(ev, 800), 0.0)
        self.assertTrue(shard.can_reserve(ev, plan(), 3, 800))

    def test_the_envelope_is_never_exceeded(self):
        p = plan(envelope_hours=7)
        ev = [reserve("a", 0), {"ev": "created", "name": "a", "creation": 1, "t": 2}]
        # charged 3 h; another 3 h VM + T_create fits in 7, a third doesn't
        self.assertTrue(shard.can_reserve(ev, p, 3, 10))
        ev += [
            reserve("b", 20),
            {"ev": "created", "name": "b", "creation": 21, "t": 22},
        ]
        self.assertFalse(shard.can_reserve(ev, p, 3, 30))


class Acceptance(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp(prefix="shard-rows-"))
        self.plan = plan()
        self.led = shard.Ledger(self.d / "ledger.jsonl")
        self.rows = shard.Rows(self.d, self.led, self.plan)

    def tearDown(self):
        shutil.rmtree(self.d)

    def accept(self, rec=None, sidecar=None, tk="x86"):
        data, side = blob(rec or row())
        return self.rows.accept(
            tk,
            "poly_fp_mul:s",
            1000,
            data,
            sidecar if sidecar is not None else side,
            "bc-vm",
        )

    def test_accept_writes_the_row_then_the_ledger(self):
        sha = self.accept()
        dest = self.d / "rows/x86/poly_fp_mul-s.json"
        self.assertEqual(hashlib.sha256(dest.read_bytes()).hexdigest(), sha)
        self.assertEqual(self.led.events[-1]["ev"], "accepted")
        self.assertEqual(list((self.d / "incoming/x86").iterdir()), [])
        self.assertTrue((self.d / "rows/x86/identity.json").exists())

    def test_rejections_in_order(self):
        data, side = blob(row())
        cases = [
            (b"x" * (shard.MAX_ROW + 1), side, "over"),
            (data, b"zz" * 40, "sidecar"),
            (data, b"0" * 64 + b"\n", "checksum"),
        ]
        for d, s, why in cases:
            with self.subTest(why=why), self.assertRaisesRegex(shard.Fatal, why):
                self.rows.accept("x86", "poly_fp_mul:s", 1000, d, s, "vm")
        for rec, why in (
            (row(n=999), "n is"),
            (row(row="other"), "row is"),
            (row(complete=False), "complete"),
            (row(status="running"), "terminal"),
            (row(expected_input_hash="1"), "the plan's"),
            (row(input_hash="1"), "input hash"),
            (row(commit="f" * 40), "commit"),
        ):
            with self.subTest(why=why), self.assertRaisesRegex(shard.Fatal, why):
                self.accept(rec)
        self.assertFalse((self.d / "rows/x86/poly_fp_mul-s.json").exists())

    def test_a_terminal_record_is_accepted_but_not_ok(self):
        self.accept(row(status="timeout"))
        self.assertTrue((self.d / "rows/x86/poly_fp_mul-s.json").exists())

    def test_an_identical_resend_is_acknowledged_a_different_one_quarantined(self):
        self.accept()
        self.accept()
        self.assertEqual(sum(e["ev"] == "accepted" for e in self.led.events), 1)
        with self.assertRaisesRegex(shard.Fatal, "quarantined"):
            self.accept(row(status="timeout"))
        self.assertEqual(len(list((self.d / "rows/x86/.conflict").iterdir())), 1)

    def test_identity_must_match_within_a_type(self):
        self.accept()
        with self.assertRaisesRegex(shard.Fatal, "identity"):
            self.rows.check_identity("x86", row(artifacts={"native": "d" * 64}))

    def test_an_unpinned_engine_is_refused(self):
        with self.assertRaisesRegex(shard.Fatal, "pinned"):
            self.accept(row(engine_pin={"ok": False}))

    def test_two_types_share_a_point_without_colliding(self):
        self.accept(tk="x86")
        self.accept(row(machine=dict(row()["machine"], arch="aarch64")), tk="arm")
        self.assertTrue((self.d / "rows/arm/poly_fp_mul-s.json").exists())
        self.assertTrue((self.d / "rows/x86/poly_fp_mul-s.json").exists())

    def test_bad_keys_never_become_paths(self):
        for tk, key in (
            ("x86", "../../etc:s"),
            ("../x", "poly_fp_mul:s"),
            ("x86", "poly_fp_mul:../s"),
            ("x86", "-rf:s"),
        ):
            with self.subTest(key=(tk, key)), self.assertRaises(shard.Fatal):
                self.rows.paths(tk, key)

    def test_recovery_adopts_a_renamed_unacknowledged_row(self):
        data, _ = blob(row())
        dest = self.d / "rows/x86/poly_fp_mul-s.json"
        dest.parent.mkdir(parents=True)
        dest.write_bytes(data)
        (self.d / "incoming/x86").mkdir(parents=True)
        (self.d / "incoming/x86/poly_fp_mul-s.part").write_bytes(b"partial")
        self.assertEqual(self.rows.recover({"poly_fp_mul:s": 1000}), 1)
        self.assertEqual(self.led.events[-1]["name"], "recovered")
        self.assertFalse((self.d / "incoming/x86/poly_fp_mul-s.part").exists())
        self.assertEqual(self.rows.recover({"poly_fp_mul:s": 1000}), 0)

    def test_recovery_quarantines_a_bad_row(self):
        dest = self.d / "rows/x86/poly_fp_mul-s.json"
        dest.parent.mkdir(parents=True)
        dest.write_bytes(json.dumps(row(n=5)).encode())
        with self.assertRaises(shard.Fatal):
            self.rows.recover({"poly_fp_mul:s": 1000})
        self.assertFalse(dest.exists())
        self.assertEqual(len(list((self.d / "rows/x86/.conflict").iterdir())), 1)

    def test_a_symlinked_part_is_not_followed(self):
        target = self.d / "outside.txt"
        target.write_text("keep")
        (self.d / "incoming/x86").mkdir(parents=True)
        os.symlink(target, self.d / "incoming/x86/poly_fp_mul-s.part")
        self.accept()
        self.assertEqual(target.read_text(), "keep")


class Clock:
    def __init__(self):
        self.t = 1_800_000_000.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


class FakeProvider:
    """GCP as sbvm.py shows it, in memory."""

    def __init__(self, clock, run_id="0123456789abcdef"):
        self.clock, self.run_id, self.vms, self.n = clock, run_id, {}, 0
        self.create_raises, self.create_but_raise, self.service_accounts, self.calls = (
            set(),
            set(),
            [],
            [],
        )

    def inst(self, name, mt, zone, image, hours):
        from datetime import datetime, timezone

        self.n += 1
        return {
            "name": name,
            "zone": zone,
            "machineType": mt,
            "status": "RUNNING",
            "creationTimestamp": datetime.fromtimestamp(
                self.clock(), timezone.utc
            ).isoformat(),
            "labels": {
                "owner": "sagebrush",
                "purpose": "bench",
                "bench-run": self.run_id,
            },
            "scheduling": {
                "provisioningModel": "SPOT",
                "instanceTerminationAction": "DELETE",
                "maxRunDuration": {"seconds": str(int(hours * 3600))},
            },
            "serviceAccounts": list(self.service_accounts),
            "sourceImage": "https://x/projects/p/global/images/" + image,
            "ip": f"10.0.0.{self.n}",
        }

    def create(self, name, mt, zone, image, hours, timeout):
        self.calls.append(("create", name))
        if name in self.create_raises:
            raise shard.ProviderError("timed out")
        self.vms[name] = self.inst(name, mt, zone, image, hours)
        if name in self.create_but_raise:
            raise shard.ProviderError("timed out after creating")

    def show(self, name):
        return self.vms.get(name)

    def names(self, prefix):
        return [v for k, v in sorted(self.vms.items()) if k.startswith(prefix)]

    def delete(self, name):
        self.calls.append(("delete", name))
        self.vms.pop(name, None)


class FakeRemote:
    """The VMs' side: run.py writes the requested point's file and sidecar."""

    def __init__(self, provider, plan):
        self.provider, self.plan, self.fs, self.log = provider, plan, {}, []
        self.build_fails, self.preempt_on, self.fetch_fails, self.corrupt = (
            False,
            set(),
            0,
            False,
        )

    def vm_of(self, ip):
        return next((n for n, v in self.provider.vms.items() if v["ip"] == ip), None)

    def push(self, ip, local, remote, timeout):
        if not self.vm_of(ip):
            raise shard.TransferError("gone")

    def run(self, ip, words, timeout):
        name = self.vm_of(ip)
        if not name:
            return {"status": "error", "output": "ssh: no route"}
        if "vm-setup.sh" in " ".join(words):
            return {"status": "error" if self.build_fails else "ok", "output": "build"}
        key = words[words.index("--only") + 1] + ":" + words[words.index("--sizes") + 1]
        self.provider.clock.t += 1000  # (a point takes time)
        self.log.append(
            (
                "run",
                key,
                name,
                len([e for e in self.ledger.events if e["ev"] == "accepted"]),
            )
        )
        if key in self.preempt_on:
            self.preempt_on.discard(key)
            self.provider.vms.pop(name)
            return {"status": "error", "output": "connection closed"}
        n = self.plan["expected_inputs"][key]["n"]
        rec = row(
            row=key.split(":")[0],
            size=key.split(":")[1],
            n=n,
            input_hash=self.plan["expected_inputs"][key]["input_hash"],
            expected_input_hash=self.plan["expected_inputs"][key]["input_hash"],
        )
        data, side = blob(rec)
        if self.corrupt:
            side = b"0" * 64 + b"\n"
        path = f"out/rows/{key.replace(':', '-')}.json"
        self.fs[(name, path)], self.fs[(name, path + ".sha256")] = data, side
        return {"status": "ok", "output": ""}

    def fetch(self, ip, path, max_bytes, timeout):
        if self.fetch_fails:
            self.fetch_fails -= 1
            raise shard.TransferError("reset")
        data = self.fs.get((self.vm_of(ip), path))
        if data is None:
            raise shard.TransferError("no such file")
        if len(data) > max_bytes:
            raise shard.TransferError("over")
        return data


class Drivers(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp(prefix="shard-run-"))
        self.clock = Clock()
        keys = ["poly_fp_mul:s", "poly_fp_gcd:s", "mat_fp_det:s"]
        exp = {
            k: {"n": n, "variants": 8, "input_hash": str(100 + i)}
            for i, (k, n) in enumerate(zip(keys, (1000, 300, 60)))
        }
        archive = self.d / "payload.tar"
        archive.write_bytes(b"payload")
        self.plan = plan(
            points=keys,
            expected_inputs=exp,
            archive_sha256=hashlib.sha256(b"payload").hexdigest(),
        )
        self.plan["types"]["x86"]["vms"] = 1
        (self.d / "plan.json").write_bytes(shard.canonical(self.plan))
        self.prov = FakeProvider(self.clock)
        self.remote = FakeRemote(self.prov, self.plan)

    def tearDown(self):
        shutil.rmtree(self.d)

    def driver(self):
        dr = shard.Driver(
            self.d,
            self.prov,
            self.remote,
            self.d / "payload.tar",
            clock=self.clock,
            sleep=self.clock.sleep,
            poll_s=30,
        )
        orig = dr.bootstrap

        def boot():
            orig()
            self.remote.ledger = dr.ledger

        dr.bootstrap = boot
        return dr

    def events(self, ev):
        return [
            e for e in shard.Ledger(self.d / "ledger.jsonl").events if e["ev"] == ev
        ]

    def test_every_point_accepted_one_at_a_time_and_the_vm_deleted(self):
        rep = self.driver().run()
        self.assertEqual((rep["accepted"], rep["left"], rep["fatal"]), (3, [], []))
        # (no point started before the previous one was accepted)
        self.assertEqual([x[3] for x in self.remote.log], [0, 1, 2])
        self.assertEqual(self.prov.vms, {})
        self.assertEqual(len(self.events("deleted")), 1)
        self.assertLessEqual(rep["charged_hours"], self.plan["envelope_hours"])

    def test_no_vm_when_the_envelope_cannot_hold_one(self):
        self.plan["envelope_hours"] = 3
        (self.d / "plan.json").write_bytes(shard.canonical(self.plan))
        rep = self.driver().run()
        self.assertEqual(self.prov.calls, [])
        self.assertEqual(len(rep["left"]), 3)

    def test_an_unknown_create_that_did_create_is_found_and_used(self):
        self.prov.create_but_raise.add("bc-0123456789abcdef-x86-0")
        rep = self.driver().run()
        self.assertEqual(rep["accepted"], 3)
        self.assertEqual(len(self.events("create-unknown")), 1)

    def test_an_unknown_create_that_never_appears_is_absent_after_its_window(self):
        self.prov.create_raises.add("bc-0123456789abcdef-x86-0")
        rep = self.driver().run()
        self.assertEqual(
            [e["name"] for e in self.events("absent")], ["bc-0123456789abcdef-x86-0"]
        )
        self.assertEqual(rep["accepted"], 3)  # (a second VM did the work)

    def test_a_vm_with_a_service_account_is_deleted_and_fatal(self):
        self.prov.service_accounts = [{"email": "x@y"}]
        rep = self.driver().run()
        self.assertTrue(rep["fatal"])
        self.assertEqual(self.prov.vms, {})
        self.assertEqual(self.remote.log, [])

    def test_a_foreign_vm_under_the_prefix_is_fatal_and_untouched(self):
        self.prov.vms["bc-0123456789abcdef-x86-9"] = self.prov.inst(
            "bc-0123456789abcdef-x86-9", "n2-standard-16", "z", "sb-base-20261112c", 3
        )
        rep = self.driver().run()
        self.assertTrue(rep["fatal"])
        self.assertIn("bc-0123456789abcdef-x86-9", self.prov.vms)
        self.assertNotIn(("delete", "bc-0123456789abcdef-x86-9"), self.prov.calls)

    def test_a_preempted_vm_is_replaced_and_both_are_charged(self):
        self.remote.preempt_on.add("poly_fp_gcd:s")
        rep = self.driver().run()
        self.assertEqual(rep["accepted"], 3)
        self.assertEqual(len(self.events("reserve")), 2)
        self.assertEqual(len(self.events("lost")), 1)
        # the lost VM is charged its life (two points: 2000 s), the
        # replacement its own; and nothing is released by the loss
        first = shard.charged_hours(
            [e for e in self.events("reserve")[:1]]
            + [
                e
                for e in shard.Ledger(self.d / "ledger.jsonl").events
                if e.get("name") == "bc-0123456789abcdef-x86-0"
                and e["ev"] in ("created", "deleted")
            ],
            self.clock(),
        )
        self.assertGreaterEqual(first, 2000 / 3600)
        self.assertGreater(rep["charged_hours"], first)

    def test_failing_copies_retire_the_vm_and_the_point_moves(self):
        self.remote.fetch_fails = shard.TRANSFER_TRIES
        rep = self.driver().run()
        self.assertEqual(rep["accepted"], 3)
        self.assertEqual(len(self.events("retired")), 1)

    def test_a_bad_checksum_is_never_accepted_and_stops_the_run(self):
        self.remote.corrupt = True
        rep = self.driver().run()
        self.assertTrue(rep["fatal"])
        self.assertEqual(self.events("accepted"), [])
        self.assertEqual(len(self.remote.log), 1)
        self.assertEqual(self.prov.vms, {})

    def test_a_failed_build_stops_the_type(self):
        self.remote.build_fails = True
        rep = self.driver().run()
        self.assertIn("x86", rep["stopped_types"])
        self.assertEqual(len(self.events("reserve")), 1)
        self.assertEqual(self.prov.vms, {})

    def test_a_changed_plan_or_payload_is_refused(self):
        self.driver().run()
        self.plan["envelope_hours"] = 17
        (self.d / "plan.json").write_bytes(shard.canonical(self.plan))
        self.assertTrue(self.driver().run()["fatal"])
        self.plan["envelope_hours"] = 18
        (self.d / "plan.json").write_bytes(shard.canonical(self.plan))
        (self.d / "payload.tar").write_bytes(b"other")
        self.assertTrue(self.driver().run()["fatal"])

    def test_a_restart_adopts_an_unacknowledged_row_and_measures_only_the_rest(self):
        key = "poly_fp_mul:s"
        e = self.plan["expected_inputs"][key]
        data, _ = blob(
            row(input_hash=e["input_hash"], expected_input_hash=e["input_hash"])
        )
        dest = self.d / "rows/x86/poly_fp_mul-s.json"
        dest.parent.mkdir(parents=True)
        dest.write_bytes(data)
        rep = self.driver().run()
        self.assertEqual(rep["accepted"], 3)
        self.assertNotIn(key, [x[1] for x in self.remote.log])


class Transport(unittest.TestCase):
    """Ssh and Sbvm against stub executables on PATH (no network)."""

    def setUp(self):
        self.d = Path(tempfile.mkdtemp(prefix="shard-stub-"))
        self.bin = self.d / "bin"
        self.bin.mkdir()
        self.old_path = os.environ["PATH"]
        os.environ["PATH"] = f"{self.bin}:{self.old_path}"

    def tearDown(self):
        os.environ["PATH"] = self.old_path
        shutil.rmtree(self.d)

    def stub(self, name, body):
        p = self.bin / name
        p.write_text("#!/bin/sh\n" + body)
        p.chmod(0o755)

    def test_fetch_returns_a_bounded_file(self):
        (self.d / "f").write_bytes(b"x" * 100)
        # (the stub "ssh" ignores its options and runs the remote words)
        self.stub("ssh", f'cd {self.d}; for a; do last="$a"; done; sh -c "$last"\n')
        self.assertEqual(shard.Ssh(self.d).fetch("10.0.0.1", "f", 1000, 10), b"x" * 100)

    def test_fetch_cuts_an_oversized_stream(self):
        self.stub("ssh", "exec yes\n")
        t0 = time.monotonic()
        with self.assertRaisesRegex(shard.TransferError, "more than"):
            shard.Ssh(self.d).fetch("10.0.0.1", "f", 1 << 16, 10)
        self.assertLess(time.monotonic() - t0, 5)

    def test_fetch_times_out_and_leaves_nothing(self):
        pidfile = self.d / "pid"
        self.stub("ssh", f"echo $$ > {pidfile}; exec sleep 600\n")
        with self.assertRaisesRegex(shard.TransferError, "timed out"):
            shard.Ssh(self.d).fetch("10.0.0.1", "f", 100, 1.0)
        time.sleep(0.2)
        pid = int(pidfile.read_text())
        self.assertFalse(
            Path(f"/proc/{pid}").exists()
            and Path(f"/proc/{pid}/stat").read_text().split()[2] != "Z"
        )

    def test_an_option_like_path_stays_a_path(self):
        log = self.d / "argv"
        self.stub("ssh", f'for a; do last="$a"; done; printf "%s" "$last" > {log}\n')
        shard.Ssh(self.d).fetch("10.0.0.1", "-rf x;y", 100, 10)
        self.assertEqual(log.read_text(), "cat -- '-rf x;y'")

    def test_a_bad_address_is_refused(self):
        with self.assertRaises(shard.TransferError):
            shard.Ssh(self.d).fetch("10.0.0.1; rm -rf ~", "f", 10, 10)

    def sbvm(self, body):
        tool = self.d / "sbvm.py"
        tool.write_text(body)
        return shard.Sbvm("0123456789abcdef", tool=tool)

    def test_sbvm_create_argv_has_exactly_the_one_label(self):
        log = self.d / "argv.json"
        vm = self.sbvm(
            f"import json, sys; json.dump(sys.argv[1:], open({str(log)!r}, 'w'))\n"
        )
        vm.create(
            "bc-0123456789abcdef-x86-0",
            "n2-standard-16",
            "northamerica-northeast2-a",
            "sb-base-20261112c",
            3,
            30,
        )
        argv = json.loads(log.read_text())
        self.assertEqual(argv[:2], ["create", "bc-0123456789abcdef-x86-0"])
        self.assertEqual(
            [argv[i + 1] for i, a in enumerate(argv) if a == "--label"],
            ["bench-run=0123456789abcdef"],
        )
        with self.assertRaises(shard.Fatal):
            vm.create("bc-x;rm", "n2-standard-16", "z", "i", 3, 30)

    def test_sbvm_failures_are_unknown_never_empty(self):
        vm = self.sbvm("import sys; sys.exit(1)\n")
        with self.assertRaises(shard.ProviderError):
            vm.names("bc-0123456789abcdef-")
        with self.assertRaises(shard.ProviderError):
            vm.create("bc-0123456789abcdef-x86-0", "n2-standard-16", "z", "i", 3, 30)
        self.assertIsNone(
            self.sbvm("print('null'); import sys; sys.exit(3)\n").show(
                "bc-0123456789abcdef-x86-0"
            )
        )


class Reconciliation(Drivers):
    """A restart after a crash at each ledger boundary."""

    def boot(self):
        dr = self.driver()
        dr.bootstrap()
        return dr

    def test_crash_after_the_reservation_fsync(self):
        dr = self.boot()
        dr.ledger.append(
            {
                "ev": "reserve",
                "name": "bc-0123456789abcdef-x86-0",
                "type": "x86",
                "zone": "z",
                "max_run_s": 10800,
                "t_create_s": 600,
            }
        )
        dr2 = self.boot()
        dr2.reconcile()
        self.assertEqual(
            shard.unknown_vms(dr2.ledger.events), ["bc-0123456789abcdef-x86-0"]
        )  # (within its window: still unknown, spending blocked)
        self.clock.t += 700
        dr2.reconcile()
        self.assertEqual(self.events("absent")[0]["name"], "bc-0123456789abcdef-x86-0")

    def test_crash_after_create_before_observation(self):
        dr = self.boot()
        name = "bc-0123456789abcdef-x86-0"
        dr.ledger.append(
            {
                "ev": "reserve",
                "name": name,
                "type": "x86",
                "zone": "northamerica-northeast2-a",
                "max_run_s": 10800,
                "t_create_s": 600,
            }
        )
        self.prov.create(
            name,
            "n2-standard-16",
            "northamerica-northeast2-a",
            "sb-base-20261112c",
            3,
            30,
        )
        dr2 = self.boot()
        dr2.reconcile()
        self.assertEqual([e["name"] for e in self.events("created")], [name])

    def test_crash_after_a_delete_request(self):
        dr = self.boot()
        name = "bc-0123456789abcdef-x86-0"
        dr.ledger.append(
            {
                "ev": "reserve",
                "name": name,
                "type": "x86",
                "zone": "northamerica-northeast2-a",
                "max_run_s": 10800,
                "t_create_s": 600,
            }
        )
        self.prov.create(
            name,
            "n2-standard-16",
            "northamerica-northeast2-a",
            "sb-base-20261112c",
            3,
            30,
        )
        dr.ledger.append({"ev": "created", "name": name, "creation": self.clock()})
        dr.ledger.append({"ev": "delete-requested", "name": name})
        # (the delete never reached GCP: the VM is still there, still billed, and the restart deletes it)
        rep = self.driver().run()
        self.assertNotIn(name, self.prov.vms)
        self.assertGreaterEqual(rep["charged_hours"], 0)
        self.assertEqual(self.events("deleted")[0]["name"], name)

    def test_ownership_checks(self):
        v = {"type": "x86", "zone": "z", "max_run_s": 10800, "reserved": self.clock()}
        good = self.prov.inst("n", "n2-standard-16", "z", "sb-base-20261112c", 3)
        self.assertEqual(shard.ownership_problems(good, v, self.plan), [])
        for change in (
            {
                "scheduling": dict(
                    good["scheduling"], maxRunDuration={"seconds": "7200"}
                )
            },
            {
                "scheduling": {
                    k: x for k, x in good["scheduling"].items() if k != "maxRunDuration"
                }
            },
            {"labels": dict(good["labels"], **{"bench-run": "ffffffffffffffff"})},
            {"machineType": "e2-micro"},
            {"sourceImage": "https://x/images/other"},
            {"serviceAccounts": [{"email": "a"}]},
            {"creationTimestamp": "2020-01-01T00:00:00+00:00"},
        ):
            with self.subTest(change=list(change)):
                self.assertTrue(
                    shard.ownership_problems(dict(good, **change), v, self.plan)
                )


class Plans2(unittest.TestCase):
    def test_make_plan_from_a_clean_tree_and_refuse_a_dirty_one(self):
        import tarfile
        from unittest import mock

        d = Path(tempfile.mkdtemp(prefix="shard-plan-"))
        repo = d / "repo"
        repo.mkdir()

        def git(*a):
            subprocess.run(
                ["git", "-c", "user.name=t", "-c", "user.email=t@t", *a],
                cwd=repo,
                check=True,
                capture_output=True,
            )

        git("init", "-q")
        (repo / "f.txt").write_text("x\n")
        git("add", "f.txt")
        git("commit", "-q", "-m", "c")
        types = plan()["types"]
        with mock.patch.object(shard, "ROOT", repo):
            sha = shard.make_plan(
                d / "run", types, 18, ["poly_fp_mul:s", "mat_fp_det:s"]
            )
            p = json.loads((d / "run/plan.json").read_text())
            self.assertEqual(shard.plan_sha(p), sha)
            shard.validate_plan(p)
            self.assertEqual(
                hashlib.sha256((d / "run/payload.tar").read_bytes()).hexdigest(),
                p["archive_sha256"],
            )
            with tarfile.open(d / "run/payload.tar") as t:
                self.assertEqual(
                    t.extractfile(".bench-commit").read().decode().strip(), p["commit"]
                )
                self.assertEqual(
                    json.loads(t.extractfile("expected-inputs.json").read()),
                    p["expected_inputs"],
                )
                self.assertIn("f.txt", t.getnames())
            self.assertEqual(
                p["expected_inputs"]["poly_fp_mul:s"]["input_hash"], "308890519"
            )
            (repo / "f.txt").write_text("changed\n")
            with self.assertRaisesRegex(shard.Fatal, "not clean"):
                shard.make_plan(d / "run2", types, 18, ["poly_fp_mul:s"])
        shutil.rmtree(d)


class Locks(unittest.TestCase):
    def test_a_second_driver_is_refused(self):
        d = Path(tempfile.mkdtemp(prefix="shard-lock-"))
        fd = shard.take_lock(d)
        code = f"import sys; sys.path.insert(0, {str(Path(shard.__file__).parent)!r}); import shard; from pathlib import Path; shard.take_lock(Path({str(d)!r}))"
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("another driver", r.stderr)
        os.close(fd)
        shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main(verbosity=1)
