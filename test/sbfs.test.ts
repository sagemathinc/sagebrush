import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRequest, checkHeader, readLength, waitPiece, writePiece, releasePiece, readHeader, headerBytes, isWorkspacePath, FS_BUFFER_BYTES, FS_MAX_READ, FS_MAX_PATH, KIND_HEADER, KIND_DATA } from "../src/sbfs";

// src/sbfs.ts, sagebrush://'s closed operations (design sagebrush-fsspec r3 §4.2, §5.5): the requests' exact form,
// the empty and end-of-file ranges, the headers' closed form, and the transport (a Stop winning, a piece of an
// earlier call skipped); then sagebrush.fs in Python through the session's sb_fs, against a synthetic page.

const buffer = () => new SharedArrayBuffer(FS_BUFFER_BYTES);
const intr = () => new Int32Array(new SharedArrayBuffer(8));
const V = "a".repeat(64);

test("requests: a closed form per operation, exact keys, checked to the character", () => {
  assert.deepEqual(checkRequest("fs.stat", { ws: null, path: "/a/b.csv" }), { request: { op: "fs.stat", params: { ws: null, path: "/a/b.csv" } } });
  assert.deepEqual(checkRequest("fs.read", { ws: "0123456789abcdef", path: "/x", version: V, offset: 0, length: FS_MAX_READ }), { request: { op: "fs.read", params: { ws: "0123456789abcdef", path: "/x", version: V, offset: 0, length: FS_MAX_READ } } });
  assert.ok("request" in checkRequest("fs.list", { ws: null, path: "/", cursor: "A".repeat(32) }));
  for (const [op, p] of [
    ["fs.write", { ws: null, path: "/x" }],
    ["fs.stat", { ws: null, path: "/x", session: "K_P" }],
    ["fs.stat", { ws: null, path: "/x", address: V }],
    ["fs.stat", { path: "/x" }],
    ["fs.stat", { ws: "nope", path: "/x" }],
    ["fs.stat", { ws: null, path: "x" }],
    ["fs.stat", { ws: null, path: "/a/../b" }],
    ["fs.stat", { ws: null, path: "/a/./b" }],
    ["fs.stat", { ws: null, path: "/a//b" }],
    ["fs.stat", { ws: null, path: "/a/" }],
    ["fs.stat", { ws: null, path: "/a\\b" }],
    ["fs.stat", { ws: null, path: "/a\0b" }],
    ["fs.stat", { ws: null, path: "/" + "x".repeat(FS_MAX_PATH) }],
    ["fs.stat", { ws: null, path: "/x", version: "A".repeat(64) }],
    ["fs.list", { ws: null, path: "/", cursor: "short" }],
    ["fs.read", { ws: null, path: "/x", version: V, offset: -1, length: 1 }],
    ["fs.read", { ws: null, path: "/x", version: V, offset: 0.5, length: 1 }],
    ["fs.read", { ws: null, path: "/x", version: V, offset: 2 ** 53, length: 1 }],
    ["fs.read", { ws: null, path: "/x", version: V, offset: 0, length: FS_MAX_READ + 1 }],
    ["fs.read", { ws: null, path: "/x", offset: 0, length: 1 }],
    ["fs.read", Object.assign(Object.create({ ws: null }), { path: "/x", version: V, offset: 0, length: 1 })],
  ] as [string, unknown][])
    assert.ok("refused" in checkRequest(op, p), JSON.stringify([op, p]).slice(0, 120));
  assert.ok(isWorkspacePath("/") && isWorkspacePath("/" + "x".repeat(FS_MAX_PATH - 1)));
});

test("ranges: zero-length and end-of-file reads never form offset + length - 1", () => {
  assert.equal(readLength(10, 0, 0), 0);
  assert.equal(readLength(10, 10, 5), 0);
  assert.equal(readLength(10, 11, 5), 0);
  assert.equal(readLength(10, 8, 5), 2);
  assert.equal(readLength(10, 0, 10), 10);
  assert.equal(readLength(2 ** 53 - 1, 2 ** 53 - 2, FS_MAX_READ), 1);
});

test("headers: an unknown code is unavailable, anything else not understood", () => {
  assert.deepEqual(checkHeader({ ok: { length: 3 } }), { ok: { length: 3 } });
  assert.deepEqual(checkHeader({ error: { code: "permission", message: "no" } }), { error: { code: "permission", message: "no" } });
  assert.equal((checkHeader({ error: { code: "teapot", message: "x" } }) as any).error.code, "unavailable");
  for (const h of [null, [], { ok: 1 }, { ok: {}, error: {} }, { error: { code: "invalid" } }, { error: { code: "invalid", message: "x".repeat(4097) } }]) assert.equal((checkHeader(h) as any).error.code, "unavailable");
});

test("the transport: pieces in order, a Stop wins, an earlier call's piece is skipped, never taken", () => {
  const b = buffer(), i = intr();
  assert.ok(writePiece(b, 1, 1, KIND_HEADER, headerBytes({ ok: { length: 3 } })));
  assert.equal(writePiece(b, 1, 2, KIND_DATA, new Uint8Array(3)), false, "not the page's turn until the worker takes the piece");
  const p = waitPiece(b, i, 1, 1);
  assert.ok("bytes" in p && p.kind === KIND_HEADER);
  assert.deepEqual(readHeader((p as any).bytes), { ok: { length: 3 } });
  releasePiece(b);
  // (call 1's late piece, then call 2's: call 2 skips the first)
  assert.ok(writePiece(b, 1, 2, KIND_DATA, new Uint8Array([9, 9, 9])));
  let hits = 0;
  const now = () => (hits++ === 3 && writePiece(b, 2, 1, KIND_HEADER, headerBytes({ ok: {} })), 0);
  const q = waitPiece(b, i, 2, 1, 1000, now, 1);
  assert.ok("bytes" in q && q.kind === KIND_HEADER, JSON.stringify(q));
  releasePiece(b);
  // a Stop wins over a piece that is there
  assert.ok(writePiece(b, 2, 2, KIND_DATA, new Uint8Array(1)));
  Atomics.store(i, 0, 1);
  assert.deepEqual(waitPiece(b, i, 2, 2), { error: "interrupted" });
  Atomics.store(i, 0, 0);
  // a wrong sequence number, a later call's piece: unavailable
  assert.deepEqual(waitPiece(b, i, 2, 3), { error: "unavailable" });
  releasePiece(b);
  assert.ok(writePiece(b, 5, 1, KIND_HEADER, new Uint8Array(0)));
  assert.deepEqual(waitPiece(b, i, 2, 1), { error: "unavailable" });
  releasePiece(b);
  // the deadline
  let t = 0;
  assert.deepEqual(waitPiece(b, i, 3, 1, 50, () => (t += 30), 1), { error: "timeout" });
});

// ------------------------------------------------------------------ sagebrush.fs in Python, a synthetic page

const enc = (s: string) => new TextEncoder().encode(s);

test("sagebrush.fs against a synthetic page: open, read, seek, info, ls, exists, cat_file, errors, pandas", async () => {
  // (Sagebrush's pandas, built as its optional set and installed, as test/fredapi.test.ts does)
  const ROOT = join(__dirname, "..", "..");
  const out0 = mkdtempSync(join(tmpdir(), "sb-fs-"));
  const S = execFileSync(process.execPath, [join(ROOT, "scripts", "optional-packages.mjs"), "build", "--out", out0, "pandas"], { encoding: "utf8" }).trim().split("\n").pop()!;
  const C = require("../src/compile");
  const { prepareSet } = require("../src/pkgcache");
  const [S2, index, readSet] = await prepareSet(join(out0, "pkgset", S + ".json"), C.coreBuildId(), C.reservedNames());
  C.installPackageSet(S2, index, readSet);
  const { notebookSession } = require("../src/notebook-session");
  const big = new Uint8Array(3 * 1024 * 1024 + 17).map((_, k) => (k * 7) & 255);
  const csv = enc("a,b\n1,2\n3,4\n");
  const files: Record<string, { bytes: Uint8Array; sha: string }> = {
    "/data/big.bin": { bytes: big, sha: "b".repeat(64) },
    "/data/t.csv": { bytes: csv, sha: "c".repeat(64) },
  };
  const old = { bytes: enc("a,b\n9,9\n"), sha: "d".repeat(64) };
  const page = { calls: [] as any[], pieceSize: 1 << 20 };
  const sbFs = (req: any, sink: (p: Uint8Array, at: number) => void) => {
    page.calls.push(JSON.parse(JSON.stringify(req.request)));
    const { op, params } = req.request;
    if (params.ws !== null) return { error: { code: "permission", message: "sagebrush://: this kernel may read only its own workspace" } };
    if (op === "fs.list") {
      if (params.path !== "/data") return { error: { code: "not_found", message: "no such folder" } };
      const names = Object.keys(files).map((p) => p.slice(6));
      return params.cursor ? { ok: { entries: names.slice(1).map((name) => ({ name, type: "file", size: 0, version: null })) } } : { ok: { entries: [{ name: names[0], type: "file", size: 0, version: null }], cursor: "C".repeat(32) } };
    }
    const f = files[params.path];
    if (!f) return params.path === "/data" && op === "fs.stat" ? { ok: { name: "data", type: "directory", size: 0 } } : { error: { code: "not_found", message: `sagebrush://${params.path}: no such file` } };
    const v = params.version === undefined || params.version === f.sha ? f : params.version === old.sha && params.path === "/data/t.csv" ? old : null;
    if (!v) return { error: { code: "not_found", message: "that version isn't in this workspace's history" } };
    if (op === "fs.stat") return { ok: { name: params.path.slice(params.path.lastIndexOf("/") + 1), type: "file", size: v.bytes.length, version: v.sha, kind: "blob" } };
    const n = Math.max(0, Math.min(params.length, v.bytes.length - params.offset));
    for (let at = 0; at < n; at += page.pieceSize) sink(v.bytes.subarray(params.offset + at, params.offset + Math.min(n, at + page.pieceSize)), at);
    return { ok: { length: n } };
  };
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true, sbFs });
  await s.ready;
  let id = 0;
  const run = async (code: string) => {
    const n = ++id;
    await s.handle({ id: n, code });
    return msgs.filter((m) => m.id === n && (m.stream || m.error)).map((m) => m.text ?? JSON.stringify(m.error)).join("");
  };
  const expect = (lo: number, hi: number) => {
    let h = 0;
    for (let k = lo; k < hi; k++) h = (h * 31 + big[k]) >>> 0;
    return h;
  };
  const PRE = "from sagebrush import fs\ndef h(b):\n    x = 0\n    for c in b:\n        x = (x * 31 + c) & 0xffffffff\n    return x\n";
  await run(PRE);
  // a ranged read: exactly the bytes asked for, one fs.read call
  page.calls = [];
  assert.equal(await run("f = fs.open('sagebrush:///data/big.bin')\nf.seek(1048570)\nb = f.read(20)\nprint(len(b), h(b), f.tell())"), `20 ${expect(1048570, 1048590)} 1048590\n`);
  assert.deepEqual(page.calls.map((c) => c.op), ["fs.stat", "fs.read"]);
  assert.equal(page.calls[1].params.offset, 1048570);
  assert.equal(page.calls[1].params.version, "b".repeat(64), "the version is pinned at open");
  // read() of the rest, past several pieces; reads past the end are empty
  assert.equal(await run("raw = fs.SagebrushFile('sagebrush:///data/big.bin')\nraw.seek(-5, 2)\nprint(list(raw.read()), raw.read(3), raw.seek(raw.size + 10), raw.read(1))"), `[${[...big.subarray(big.length - 5)].join(", ")}] b'' ${big.length + 10} b''\n`);
  assert.equal(await run("raw = fs.SagebrushFile('sagebrush:///data/big.bin')\nb = raw.read()\nprint(len(b), h(b) == " + expect(0, big.length) + ")"), `${big.length} True\n`);
  // readinto a memoryview, text mode, info, exists, cat_file
  assert.equal(await run("f = fs.SagebrushFile('sagebrush:///data/big.bin')\nm = bytearray(10)\nprint(f.readinto(memoryview(m)[2:7]), list(m[2:7]) == list(range(0, 35, 7)))"), "5 True\n");
  assert.equal(await run("print(fs.open('sagebrush:///data/t.csv', 'r').read().splitlines())"), "['a,b', '1,2', '3,4']\n");
  assert.equal(await run("i = fs.info('sagebrush:///data/t.csv')\nprint(i['type'], i['size'], fs.exists('sagebrush:///data/t.csv'), fs.exists('sagebrush:///data/nope'))"), "file 12 True False\n");
  assert.equal(await run("print(fs.cat_file('sagebrush:///data/t.csv', 4, -4), fs.cat_file('sagebrush:///data/t.csv', 20))"), "b'1,2\\n' b''\n");
  // a version by ?v=
  assert.equal(await run(`print(fs.cat_file('sagebrush:///data/t.csv?v=${old.sha}'))`), "b'a,b\\n9,9\\n'\n");
  assert.equal(await run(`try:\n    fs.open('sagebrush:///data/t.csv?v=${"e".repeat(64)}')\nexcept FileNotFoundError as e:\n    print(e)`), "that version isn't in this workspace's history\n");
  // ls follows the cursor; URLs carry the workspace as given
  assert.equal(await run("print(fs.ls('sagebrush:///data'))"), "['sagebrush:///data/big.bin', 'sagebrush:///data/t.csv']\n");
  // errors: another workspace, a write mode, a bad URL, a folder opened
  assert.equal(await run("for u, m in [('sagebrush://0123456789abcdef/x', 'rb'), ('sagebrush:///data/t.csv', 'wb'), ('sagebrush:///a/../b', 'rb'), ('sagebrush:///data', 'rb')]:\n    try:\n        fs.open(u, m)\n    except Exception as e:\n        print(type(e).__name__, e)"),
    "PermissionError sagebrush://: this kernel may read only its own workspace\nPermissionError sagebrush:// is read-only\nValueError 'sagebrush:///a/../b': not a normalized workspace path\nIsADirectoryError sagebrush:///data: a folder\n");
  // Sagebrush's pandas reads a sagebrush:// CSV
  const out = await run("import pandas as pd\ndf = pd.read_csv('sagebrush:///data/t.csv')\nprint(list(df.columns), df['b'].tolist())");
  assert.equal(out, "['a', 'b'] [2, 4]\n");
});
