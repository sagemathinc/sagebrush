import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";
import { BRANCH, GIT_BRANCH, branchFor, excluded, fetchWords, gitUnsafe, parseRepo, pushWords, signature, stripOutputs } from "../web/gitpush/rules";
import Sha1 from "../web/gitpush/shims/sha1";
import crc from "../web/gitpush/shims/crc32";

// web/gitpush/rules.ts: "Push project to GitHub"'s rules (Stage A MVP r1 §1). The browser flow: web/gitpush/test-gitpush.mjs.

test("parseRepo: a github.com repository's address, and nothing else", () => {
  assert.deepEqual(parseRepo("https://github.com/octo/notes"), { owner: "octo", repo: "notes", url: "https://github.com/octo/notes.git" });
  assert.deepEqual(parseRepo(" https://github.com/octo/notes.git/ "), { owner: "octo", repo: "notes", url: "https://github.com/octo/notes.git" });
  for (const s of ["http://github.com/octo/notes", "https://gitlab.com/octo/notes", "https://github.com.evil.test/o/r", "https://github.com/octo", "https://github.com/octo/notes/tree/main",
    "https://github.com/../notes", "https://github.com/octo/..", "https://github.com/.x/notes", "https://github.com/octo/no tes", "https://user@github.com/octo/notes", "github.com/octo/notes"]) assert.equal(parseRepo(s), null, s);
});

test("branchFor: sagebrush/<the folder's name, made safe>; only such branches are pushed", () => {
  assert.equal(branchFor("/"), "sagebrush/workspace");
  assert.equal(branchFor("/proj"), "sagebrush/proj");
  assert.equal(branchFor("/a/My Thesis (draft)/"), "sagebrush/my-thesis-draft");
  assert.equal(branchFor("/Über"), "sagebrush/uber");
  assert.equal(branchFor("/..."), "sagebrush/workspace");
  assert.equal(branchFor("/" + "x".repeat(100)).length, "sagebrush/".length + 60);
  for (const f of ["/", "/proj", "/a/My Thesis (draft)", "/Über", "/...", "/.hidden", "/-x-", "/" + "y".repeat(90), "/日本"]) assert.match(branchFor(f), BRANCH, f);
  for (const b of ["main", "master", "sagebrush/", "sagebrush/-x", "sagebrush/a/b", "refs/heads/sagebrush/x", "sagebrush/X", "sagebrush/" + "z".repeat(61)]) assert.doesNotMatch(b, BRANCH, b);
});

test("gitUnsafe and excluded: git's verify_path names, and Sagebrush's own data, in any segment", () => {
  for (const n of [".git", ".GIT", ".Git", ".git.", ".git ", ".git. .", "git~1", "GIT~1", ".gitmodules", ".GitModules", ".gitmodules.", "gitmod~1", ".g‌it", "﻿.git", ".git::$INDEX_ALLOCATION", "", ".", ".."]) assert.ok(gitUnsafe(n), JSON.stringify(n));
  for (const n of [".gitignore", ".gitattributes", ".github", "git", "x.git", ".git-x", "gitmod~x", "a"]) assert.ok(!gitUnsafe(n), n);
  assert.equal(excluded("a/b.txt"), null);
  assert.equal(excluded(".github/workflows/ci.yml"), null);
  assert.match(excluded(".sagebrush/history-1.json")!, /Sagebrush's own data/);
  assert.match(excluded("data/.sagebrush-data/snap/blob")!, /Sagebrush's own data/);
  assert.match(excluded("x/.GIT/config")!, /can't hold/);
  assert.match(excluded("sub/.gitmodules")!, /can't hold/);
});

test("stripOutputs: every code cell's outputs, count and run time go; markdown and raw stay as they are", () => {
  const doc = { mode: "python", metadata: { k: 1 }, cells: [
    { id: "a", code: "1", outputs: [{ output_type: "stream", name: "stdout", text: "x" }], n: "4", ms: 9 },
    { id: "b", type: "code", code: "2", outputs: [{ output_type: "error", traceback: [] }], n: 5 },
    { id: "c", type: "markdown", code: "# h", attachments: { a: 1 } },
    { id: "d", type: "raw", code: "r" },
  ] };
  const s = stripOutputs(doc);
  assert.deepEqual(s.cells.map((c: any) => [c.outputs, c.n, c.ms]), [[[], null, undefined], [[], null, undefined], [undefined, undefined, undefined], [undefined, undefined, undefined]]);
  assert.deepEqual(s.cells[2], doc.cells[2]);
  assert.equal(s.metadata, doc.metadata);
  assert.equal(doc.cells[0].outputs!.length, 1, "the document itself is untouched");
});

test("signature: a data file's hash, size and revision; documents have none (always read)", () => {
  assert.equal(signature({ kind: "file", sha256: "ab", size: 3, rev: 2 }), "ab:3:2");
  assert.notEqual(signature({ kind: "file", sha256: "ab", size: 3, rev: 3 }), signature({ kind: "file", sha256: "ab", size: 3, rev: 2 }));
  assert.equal(signature({ kind: "file", size: 3 }), null);
  assert.equal(signature({ kind: "notebook", rev: 3 }), null);
  assert.equal(signature({ kind: "board" }), null);
});

test("pushWords: fixed words for each failure, never GitHub's own message", () => {
  const r = "https://github.com/o/r.git";
  assert.match(pushWords({ code: "PushRejectedError" }, "sagebrush/p", r), /has commits this browser doesn't have\. Nothing was overwritten\./);
  assert.match(pushWords({ code: "HttpError", data: { statusCode: 401 } }, "sagebrush/p", r), /refused the token \(401\)/);
  assert.match(pushWords({ code: "HttpError", data: { statusCode: 403 } }, "sagebrush/p", r), /refused the token \(403\)/);
  assert.match(pushWords({ code: "HttpError", data: { statusCode: 404 } }, "sagebrush/p", r), /\(404\)/);
  assert.match(pushWords({ code: "HttpError", data: { statusCode: 413 } }, "sagebrush/p", r), /100 MB/);
  assert.match(pushWords({ code: "HttpError", data: { statusCode: 429 } }, "sagebrush/p", r), /try again in a minute/);
  assert.equal(pushWords({ code: "HttpError", data: { statusCode: 500, statusMessage: "Authorization: Basic SECRET" } as any }, "sagebrush/p", r), "The push failed (500).");
  assert.equal(pushWords(undefined, "sagebrush/p", r), "Couldn't reach GitHub through the push proxy.");
});

// (the worker's own SHA-1 and CRC-32, in place of sha.js and crc-32: web/gitpush/shims)
test("the SHA-1 shim equals node:crypto's, at every length around the block edges, fed whole or in pieces", () => {
  const lens = [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4096, 100_003];
  for (const n of lens) {
    const b = randomBytes(n);
    const want = createHash("sha1").update(b).digest("hex");
    assert.equal(new Sha1().update(b).digest("hex"), want, `length ${n}`);
    const h = new Sha1();
    for (let i = 0; i < n; i += 37) h.update(new Uint8Array(b.subarray(i, i + 37)));
    assert.equal(Buffer.from(h.digest()).toString("hex"), want, `length ${n}, in pieces`);
  }
  assert.equal(new Sha1().update("blob 6\0hello\n").digest("hex"), "ce013625030ba8dba906f756967f9e9ca394464a", "git's id of a blob");
  assert.ok(Buffer.isBuffer(new Sha1().update("x").digest()), "a Buffer where there is one, as sha.js gives");
});

test("the CRC-32 shim equals node:zlib's (signed, as crc-32 returns it)", () => {
  for (const n of [0, 1, 7, 64, 1000, 65_537]) {
    const b = randomBytes(n);
    assert.equal(crc.buf(b) >>> 0, crc32(b), `length ${n}`);
    assert.equal(crc.buf(b), crc32(b) | 0);
  }
});

test("GIT_BRANCH and fetchWords (M4b): branch names git takes, and fixed words for a failed copy", () => {
  for (const b of ["main", "agent/x", "sagebrush/proj", "feature/a-b_c.d", "v1.2", "a/b/c"]) assert.match(b, GIT_BRANCH, b);
  for (const b of ["", "a..b", "a//b", "/a", "a/", ".a", "a/.b", "a.lock", "a.lock/b", "a.", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "x".repeat(101), "refs/heads/../x"]) assert.doesNotMatch(b, GIT_BRANCH, b);
  const r = "https://github.com/o/r.git";
  assert.equal(fetchWords({ code: "NotFoundError" }, "agent/x", r), "https://github.com/o/r.git has no branch agent/x.");
  assert.match(fetchWords({ code: "HttpError", data: { statusCode: 401 } }, "agent/x", r), /refused the token \(401\)/);
  assert.equal(fetchWords({ code: "HttpError", data: { statusCode: 500 } }, "agent/x", r), "The copy failed (500).");
  assert.equal(fetchWords(undefined, "agent/x", r), "Couldn't reach GitHub through the push proxy.");
});
