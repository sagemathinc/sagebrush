import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReplacing, type WriteIo } from "../src/fs-write";

// src/fs-write.ts, `sagebrush notebook`'s api/file PUT: a notebook's new contents in place whole or not at all, with
// short writes and failures injected through `io`, as astra's LOCAL-CONTAIN-3 did.
const dir = mkdtempSync(join(tmpdir(), "sb-fs-write-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
let k = 0;
const fresh = () => { const d = join(dir, String(++k)); mkdirSync(d); return d; };
const ORIGINAL = "ORIGINAL COMPLETE NOTEBOOK";
const NEW = Buffer.from('{"cells": ["the new contents, all of them"]}');
const left = (d: string) => readdirSync(d).sort();
// (the real calls, with writeSync replaced)
const withWrite = (writeSync: WriteIo["writeSync"]): WriteIo => ({ ...fs, writeSync });

test("a plain write: the new contents whole, no temporary file left", () => {
  const d = fresh();
  writeFileSync(join(d, "a.ipynb"), ORIGINAL);
  writeReplacing(d, "a.ipynb", NEW);
  assert.equal(readFileSync(join(d, "a.ipynb"), "utf8"), NEW.toString());
  assert.deepEqual(left(d), ["a.ipynb"]);
});

test("LOCAL-CONTAIN-3: short writes (3 bytes at a time) are completed: the new contents whole", () => {
  const d = fresh();
  writeFileSync(join(d, "a.ipynb"), ORIGINAL);
  let calls = 0;
  writeReplacing(d, "a.ipynb", NEW, withWrite(((fd: number, buf: Uint8Array, off: number, len: number) => { calls++; return fs.writeSync(fd, buf, off, Math.min(3, len)); }) as any));
  assert.equal(readFileSync(join(d, "a.ipynb"), "utf8"), NEW.toString());
  assert.ok(calls > 3, `the rest was written in further calls (${calls})`);
  assert.deepEqual(left(d), ["a.ipynb"]);
});

test("a failure after a partial write: the notebook as it was, the temporary file removed", () => {
  const d = fresh();
  writeFileSync(join(d, "a.ipynb"), ORIGINAL);
  let calls = 0;
  assert.throws(() => writeReplacing(d, "a.ipynb", NEW, withWrite(((fd: number, buf: Uint8Array, off: number, len: number) => {
    if (++calls === 1) return fs.writeSync(fd, buf, off, Math.min(3, len));
    const e: any = new Error("EIO: i/o error, write"); e.code = "EIO"; throw e;
  }) as any)), /EIO/);
  assert.equal(readFileSync(join(d, "a.ipynb"), "utf8"), ORIGINAL);
  assert.deepEqual(left(d), ["a.ipynb"]);
});

test("a write that makes no progress: refused, the notebook as it was", () => {
  const d = fresh();
  writeFileSync(join(d, "a.ipynb"), ORIGINAL);
  assert.throws(() => writeReplacing(d, "a.ipynb", NEW, withWrite((() => 0) as any)), /no progress/);
  assert.equal(readFileSync(join(d, "a.ipynb"), "utf8"), ORIGINAL);
  assert.deepEqual(left(d), ["a.ipynb"]);
});

test("a failed rename: the notebook as it was, the temporary file removed", () => {
  const d = fresh();
  writeFileSync(join(d, "a.ipynb"), ORIGINAL);
  assert.throws(() => writeReplacing(d, "a.ipynb", NEW, { ...fs, renameSync: () => { throw new Error("EXDEV"); } } as WriteIo), /EXDEV/);
  assert.equal(readFileSync(join(d, "a.ipynb"), "utf8"), ORIGINAL);
  assert.deepEqual(left(d), ["a.ipynb"]);
});

test("a new notebook: made whole; an empty body: an empty file", () => {
  const d = fresh();
  writeReplacing(d, "new.ipynb", NEW);
  assert.equal(readFileSync(join(d, "new.ipynb"), "utf8"), NEW.toString());
  writeReplacing(d, "empty.ipynb", Buffer.alloc(0));
  assert.ok(existsSync(join(d, "empty.ipynb")) && readFileSync(join(d, "empty.ipynb")).length === 0);
});
