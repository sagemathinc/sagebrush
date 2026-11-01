import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/check-par.mjs (no-cliffs C-2c scope r2 section 1.5): every parallel
// mechanism in an engine crate's src/ goes through sagebrush-par.  The real
// tree passes; each bypass spelling in a fixture tree fails, and only the
// reviewed exemptions are honoured.
const script = join(__dirname, "..", "..", "scripts", "check-par.mjs");
const repo = join(__dirname, "..", "..");

const run = (root: string) => spawnSync(process.execPath, [script, root], { encoding: "utf8" });

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "check-par-"));
  for (const [p, text] of Object.entries(files)) {
    const f = join(root, p);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, text);
  }
  return root;
}

test("the engine crates route every parallel entry through sagebrush-par", () => {
  const r = run(repo);
  assert.equal(r.status, 0, r.stderr);
});

const BYPASSES: [string, string][] = [
  ["a direct rayon::join", "fn f() { rayon::join(|| 1, || 2); }"],
  ["an aliased rayon import", "use rayon::join as j;\nfn f() { j(|| 1, || 2); }"],
  ["a rayon prelude glob", "use rayon::prelude::*;"],
  ["a parallel iterator method", "fn f(v: &[u8]) -> usize { v.par_iter().count() }"],
  ["a turbofish parallel method", "fn f(v: &mut [u8]) { v.par_chunks_mut::<>(2); }"],
  ["into_par_iter", "fn f() { (0..4).into_par_iter(); }"],
  ["a thread pool", "fn f() { let p = ThreadPoolBuilder::new(); }"],
  ["std::thread::scope", "fn f() { std::thread::scope(|s| { s.spawn(|| ()); }); }"],
  ["std::thread::spawn", "fn f() { std::thread::spawn(|| ()); }"],
  ["thread::Builder", "use std::thread;\nfn f() { thread::Builder::new(); }"],
  ["an aliased std::thread", "use std::thread as t;\nfn f() { t::spawn(|| ()); }"],
  ["an imported scope", "use std::thread::{scope, sleep};\nfn f() { scope(|s| ()); }"],
  ["an imported spawn", "use std::thread::spawn;"],
  ["std::thread in a std group import", "use std::{sync::Mutex, thread};"],
  ["a cfg(test) module without a reviewed entry", "#[cfg(test)]\nmod tests {\n    fn t() { std::thread::spawn(|| ()); }\n}"],
  // daybreak2's CENSUS-C2CI-4 and astra2's CORR-C2CI-4
  ["a grouped self alias of std::thread", "use std::thread::{self as t};\npub fn f() { t::spawn(|| ()).join().unwrap(); }"],
  ["a multiline grouped import and a direct spawn", "use std::thread::{\n    spawn,\n};\npub fn f() { spawn(|| ()).join().unwrap(); }"],
  ["a multiline grouped std import of thread", "use std::{\n    sync::Mutex,\n    thread as th,\n};\npub fn f() { th::scope(|_| ()); }"],
  ["a renamed import", "use std::thread::scope as sc;\npub fn f() { sc(|_| ()); }"],
  ["a glob import of std::thread", "use std::thread::*;\npub fn f() { spawn(|| ()); }"],
  ["a string holding // before a spawn on the same line", "pub fn f() { let s = \"a//b\"; std::thread::spawn(|| ()); }"],
  ["a spawn after a closed block comment", "pub fn f() { /* note */ std::thread::spawn(|| ()); }"],
  ["a spaced path", "pub fn f() { std :: thread :: spawn(|| ()); }"],
];

for (const [what, src] of BYPASSES) {
  test(`check-par fails on ${what}`, () => {
    const r = run(tree({ "engine/demo/src/lib.rs": src }));
    assert.equal(r.status, 1, `${what} passed: ${r.stdout}`);
    assert.match(r.stderr, /engine\/demo\/src\/lib\.rs:\d+: .* outside sagebrush-par/);
  });
}

test("check-par passes the wrapper itself, comments, non-spawning std::thread uses and the reviewed exemptions only", () => {
  const ok = run(
    tree({
      "engine/par/src/lib.rs": "use rayon::prelude::*;\nfn f() { rayon::join(|| 1, || 2); }",
      "engine/demo/src/lib.rs": "// rayon closures do not inherit #[target_feature]\nfn f() -> std::thread::ThreadId { std::thread::current().id() }\nfn g() { std::thread::sleep(std::time::Duration::ZERO); let _ = std::thread::available_parallelism(); }\n/* rayon::join in a block comment, /* nested */ thread::spawn */\nconst S: &str = \"rayon::join and std::thread::spawn in a string\";\nconst R: &str = r#\"thread::scope in a \"raw\" string\"#;\nfn h<'a>(x: &'a str) -> char { let _ = x; '/' }\nuse std::thread::sleep;",
      "engine/demo/tests/t.rs": "fn t() { std::thread::spawn(|| ()); }",
      "engine/ledger/src/tests.rs": "fn t() { std::thread::spawn(|| ()); }",
      "engine/interrupt/src/progress.rs": "        let a = std::thread::spawn(move || {",
      "engine/py/src/serve.rs": "fn s() {\n    std::thread::Builder::new()\n        .name(\"sagebrush-control\".into());\n    let t = std::thread::spawn(move || {\n    });\n}",
    }),
  );
  assert.equal(ok.status, 0, ok.stderr);
  // an exemption is by file and line text: the same call elsewhere fails
  const bad = run(tree({ "engine/interrupt/src/progress.rs": "        let b = std::thread::spawn(move || {" }));
  assert.equal(bad.status, 1);
  // serve.rs's two entries cover those two lines only: any other spawn there, or the same line in another file, fails
  // (typed: an array of differently-keyed literals would infer a union with optional undefined keys, not tree()'s Record)
  const cases: Record<string, string>[] = [
    { "engine/py/src/serve.rs": "fn s() { std::thread::scope(|_| ()); }" },
    { "engine/py/src/serve.rs": "fn s() { let u = std::thread::spawn(move || {}); }" },
    { "engine/py/src/lib.rs": "fn s() { std::thread::Builder::new(); }" },
    // exact match: forbidden code riding on an exempt line fails
    { "engine/py/src/serve.rs": "        std::thread::Builder::new(); std::thread::spawn(|| ());" },
    { "engine/interrupt/src/progress.rs": "        let a = std::thread::spawn(move || {}); rayon::join(|| 1, || 2);" },
  ];
  for (const files of cases) {
    const r = run(tree(files));
    assert.equal(r.status, 1, JSON.stringify(files));
  }
});
