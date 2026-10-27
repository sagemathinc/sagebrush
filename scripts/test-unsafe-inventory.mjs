// scripts/unsafe-inventory.mjs: every way of overriding or widening the unsafe_code lint is refused, a
// changed or new allowed item fails until reviewed, and the tokenizer isn't fooled by strings or comments.
//   node scripts/test-unsafe-inventory.mjs
import { check, compilerSites, scan, scanFile, tokenize } from "./unsafe-inventory.mjs";

let failures = 0;
const ok = (c, what) => (c ? console.log("ok  ", what) : (failures++, console.log("FAIL", what)));
const errs = (src) => scanFile("engine/x/src/lib.rs", src).errors;
const items = (src) => scanFile("engine/x/src/lib.rs", src).items;

// the accepted form
const good = "#[no_mangle]\n// SAFETY: ...\n#[allow(unsafe_code)]\npub extern \"C\" fn sb_x() -> u32 { unsafe { f() } }\n";
ok(errs(good).length === 0 && items(good).length === 1 && items(good)[0].item === "fn sb_x", "an outer #[allow(unsafe_code)] on an item is accepted and named");

// lint-override attempts: each refused, whatever the spelling
for (const [what, src] of [
  ["warn", "#[warn(unsafe_code)]\nfn f() { unsafe { g() } }"],
  ["expect", "#[expect(unsafe_code)]\nfn f() { unsafe { g() } }"],
  ["forbid (not yet allowed anywhere)", "#![forbid(unsafe_code)]\n"],
  ["deny on an item", "#[deny(unsafe_code)]\nfn f() {}"],
  ["an inner allow (module-wide)", "#![allow(unsafe_code)]\nfn f() { unsafe { g() } }"],
  ["cfg_attr", "#[cfg_attr(all(), allow(unsafe_code))]\nfn f() { unsafe { g() } }"],
  ["another lint in the list", "#[allow(dead_code, unsafe_code)]\nfn f() { unsafe { g() } }"],
  ["unsafe_code first in a list", "#[allow(unsafe_code, dead_code)]\nfn f() { unsafe { g() } }"],
  ["a lint named in a macro's arguments", "m!(allow, unsafe_code);"],
  ["an attribute assembled by a macro", "macro_rules! m { ($l:ident) => { #[allow($l)] fn f() {} } }\nm!(unsafe_code);"],
  ["a bare path use", "const L: &str = stringify!(unsafe_code);"],
]) ok(errs(src).length > 0, `refused: ${what}`);

// each site exactly once
ok(errs("#[allow(unsafe_code)]\nimpl A {\n    #[allow(unsafe_code)]\n    fn f() { unsafe { g() } }\n}\n").some((e) => /inside another allowed item/.test(e)), "refused: an allow nested inside an allowed item");

// strings, comments, raw strings and char literals don't count, and don't confuse item ends
ok(errs('// #[warn(unsafe_code)]\n/* #![allow(unsafe_code)] /* nested */ */\nconst S: &str = "#[warn(unsafe_code)]";\nconst R: &str = r#"unsafe_code"#;\n').length === 0, "comments (nested), strings and raw strings naming the lint are ignored");
const ch = "#[allow(unsafe_code)]\nfn f() -> char { let _ = '}'; let _ = '\\''; unsafe { g() }; 'x' }\nfn after() {}\n";
ok(items(ch).length === 1 && errs(ch).length === 0, "char literals with braces and quotes don't end the item early");
const life = "#[allow(unsafe_code)]\nfn f<'a>(x: &'a [u8]) -> &'a u8 { unsafe { x.get_unchecked(0) } }\n";
ok(items(life).length === 1, "lifetimes aren't char literals");
ok(tokenize("r#type").map((t) => t.v).join() === "type", "raw identifiers");

// the hash moves with a token change, not with comments or layout; outer attributes are included
const h = (src) => items(src)[0].hash;
const base = "#[no_mangle]\n#[allow(unsafe_code)]\nfn f() { unsafe { g(1) } }\n";
ok(h(base) === h("#[no_mangle]\n#[allow(unsafe_code)]\nfn f() {\n    // a comment\n    unsafe { g(1) }\n}\n"), "comments and layout don't move the hash");
ok(h(base) !== h("#[no_mangle]\n#[allow(unsafe_code)]\nfn f() { unsafe { g(2) } }\n"), "a token change moves the hash");
ok(h(base) !== h("#[export_name = \"y\"]\n#[allow(unsafe_code)]\nfn f() { unsafe { g(1) } }\n"), "a changed outer attribute moves the hash");

// items in impls are named by their context; macro-generated items by the macro
const ctx = "impl A { #[allow(unsafe_code)] fn new() {} }\nimpl B { #[allow(unsafe_code)] fn new() {} }\nmacro_rules! d { () => { #[allow(unsafe_code)] fn $name() {} } }\n";
ok(JSON.stringify(items(ctx).map((x) => x.item)) === JSON.stringify(["impl A > fn new", "impl B > fn new", "macro_rules ! d > fn $name"]), "names carry their impl / macro context");

// the inventory comparison
const found = [{ file: "engine/x/src/lib.rs", item: "fn f", hash: "aa" }];
const inv = (hash, audit = "No: ...") => ({ items: [{ file: "engine/x/src/lib.rs", item: "fn f", hash, audit }] });
ok(check(inv("aa"), found).length === 0, "a pinned, audited item passes");
ok(check(inv("bb"), found).some((e) => /changed/.test(e)), "a changed item fails until re-reviewed");
ok(check({ items: [] }, found).some((e) => /new allowed item/.test(e)), "a new item fails until added with its review");
ok(check(inv("aa"), []).some((e) => /not found/.test(e)), "a removed item fails until removed from the inventory");
ok(check(inv("aa", "UNAUDITED"), found).some((e) => /no audit/.test(e)), "an unaudited item fails");
ok(check(inv("aa"), [...found, ...found]).some((e) => /two allowed items/.test(e)), "two items with one name fail");

// the configuration: member lints, the workspace level, the lint named elsewhere
const files = ["engine/Cargo.toml", "engine/a/Cargo.toml", "engine/a/src/lib.rs", ".cargo/config.toml", "scripts/build-x.mjs"];
const tree = (o) => (f) => o[f] ?? "";
const ws = '[workspace]\nmembers = ["a"]\n\n[workspace.lints.rust]\nunsafe_code = "deny"\n';
const member = '[package]\nname = "a"\n\n[lints]\nworkspace = true\n';
ok(scan(files, tree({ "engine/Cargo.toml": ws, "engine/a/Cargo.toml": member })).errors.length === 0, "a correct configuration passes");
ok(scan(files, tree({ "engine/Cargo.toml": ws.replace('"deny"', '"warn"'), "engine/a/Cargo.toml": member })).errors.length > 0, "refused: the workspace lint not deny");
ok(scan(files, tree({ "engine/Cargo.toml": ws, "engine/a/Cargo.toml": '[package]\nname = "a"\n' })).errors.length > 0, "refused: a member without [lints] workspace = true");
ok(scan(files, tree({ "engine/Cargo.toml": ws, "engine/a/Cargo.toml": member + "\n[lints.rust]\nunsafe_code = \"allow\"\n" })).errors.length > 0, "refused: a member's own lint table");
ok(scan(files, tree({ "engine/Cargo.toml": ws, "engine/a/Cargo.toml": member, ".cargo/config.toml": '[build]\nrustflags = ["-A", "unsafe_code"]\n' })).errors.length > 0, "refused: RUSTFLAGS -A unsafe_code in a cargo config");
ok(scan(files, tree({ "engine/Cargo.toml": ws, "engine/a/Cargo.toml": member, "scripts/build-x.mjs": 'execFileSync("cargo", ["rustc", "--", "--cap-lints", "warn"])' })).errors.length > 0, "refused: --cap-lints in a build script");

// ---- #234 r2 U2: the workspace model refuses what it can't account for
{
  const files = ["engine/Cargo.toml", "engine/a/Cargo.toml", "engine/a/src/lib.rs"];
  const base = { "engine/Cargo.toml": ws, "engine/a/Cargo.toml": member };
  const errsOf = (extraFiles, over) => scan([...files, ...extraFiles], tree({ ...base, ...over })).errors;
  ok(errsOf([], {}).length === 0, "U2: the plain model passes");
  ok(errsOf(["engine/helper/Cargo.toml"], { "engine/a/Cargo.toml": member + '\n[dependencies]\nhelper = { path = "../helper" }\n', "engine/helper/Cargo.toml": '[package]\nname = "helper"\n' }).some((e) => /isn't a listed workspace member/.test(e)) , "U2 refused: an implicit path-dependency member");
  ok(errsOf([], { "engine/Cargo.toml": ws.replace('["a"]', '["a", "crates/*"]') }).some((e) => /glob/.test(e)), "U2 refused: a glob member");
  ok(errsOf(["engine/a/sub/Cargo.toml"], { "engine/a/sub/Cargo.toml": '[package]\nname = "sub"\n' }).some((e) => /isn't a listed workspace member/.test(e)), "U2 refused: a nested manifest");
  ok(errsOf([], { "engine/Cargo.toml": ws + 'exclude = ["x"]\n' }).some((e) => /exclude/.test(e)), "U2 refused: workspace exclude");
  ok(errsOf([], { "engine/a/Cargo.toml": member + '\n[dependencies]\nw = { path = "../../web/w" }\n' }).some((e) => /path dependency/.test(e)), "U2 refused: a path dependency out of engine/");
  ok(errsOf([], { "engine/a/Cargo.toml": member + '\n[target.\'cfg(windows)\'.dev-dependencies.h]\npath = "../h"\n' }).some((e) => /path dependency/.test(e)), "U2 refused: a target-specific table-form path dependency");
  ok(errsOf([], { "engine/a/Cargo.toml": member + '\n[patch.crates-io]\nx = { path = "x" }\n' }).some((e) => /patch/.test(e)), "U2 refused: [patch]");
  ok(errsOf([], { "engine/Cargo.toml": ws.replace('["a"]', '["a", "gone"]') }).some((e) => /no tracked manifest/.test(e)), "U2 refused: a listed member without a manifest (never a deleted success)");
  ok(errsOf([], { "engine/a/Cargo.toml": '[package]\nname = "a"\n' }).some((e) => /lints\] workspace = true missing/.test(e)), "U2 refused: missing lint inheritance");
  ok(scan([...files, "engine/a/src/x.rs"], tree({ ...base, "engine/a/src/x.rs": "pub use sagebrush_ledger::Reservation;\n" })).errors.some((e) => /re-exports sagebrush_ledger/.test(e)), "refused: a ledger re-export (the audits' premise)");
  ok(scan([...files, "engine/a/src/x.rs"], tree({ ...base, "engine/a/src/x.rs": "pub use ::sagebrush_ledger as l;\n" })).errors.some((e) => /re-exports/.test(e)), "refused: a ledger re-export through ::");
  ok(scan(files, tree({ ...base, "engine/a/Cargo.toml": member + '\n[dependencies]\nsagebrush-ledger = { path = "../ledger" }\n' }), { no_ledger_dep: ["a"] }).errors.some((e) => /against the audits' premise/.test(e)), "refused: a premise crate gaining a ledger dependency");
}

// ---- #234 r2 U3a: override spellings, normalized, in every build input
{
  const files = ["engine/Cargo.toml", "engine/a/Cargo.toml", ".cargo/config.toml", ".github/workflows/x.yml", "web/x.rs", ".github/workflows/ci.yml"];
  const base = { "engine/Cargo.toml": ws, "engine/a/Cargo.toml": member, ".github/workflows/ci.yml": "env:\n  RUSTFLAGS: \"--force-warn unsafe-code\"\n" };
  const errsOf = (over) => scan(files, tree({ ...base, ...over })).errors;
  ok(errsOf({}).length === 0, "U3a: the sweep's own flag line, once, is the only expected mention");
  for (const [what, f, t] of [
    ["-A unsafe-code (hyphen) in a cargo config", ".cargo/config.toml", '[build]\nrustflags = ["-A", "unsafe-code"]\n'],
    ["--force-warn in another workflow", ".github/workflows/x.yml", 'env:\n  RUSTFLAGS: "--force-warn unsafe-code"\n'],
    ["a mixed-case spelling", ".cargo/config.toml", '[build]\nrustflags = ["-AUnsafe_Code"]\n'],
    ["cap-lints", ".cargo/config.toml", '[build]\nrustflags = ["--cap-lints=warn"]\n'],
    ["a second lint table in engine/Cargo.toml", "engine/Cargo.toml", ws + '\n[lints.rust]\nunsafe_code = "allow"\n'],
    ["a second sweep line in ci.yml", ".github/workflows/ci.yml", 'env:\n  RUSTFLAGS: "--force-warn unsafe-code"\n  X: "--force-warn unsafe-code"\n'],
    ["Rust outside engine/ naming the lint", "web/x.rs", "#![allow(unsafe_code)]\n"],
  ]) ok(errsOf({ [f]: t }).length > 0, `U3a refused: ${what}`);
}

// ---- #234 r2 U1: compiler sites against the pinned items (synthetic cargo JSON)
{
  const found = [{ file: "engine/x/src/lib.rs", item: "fn f", hash: "h", from: 10, to: 20 }];
  const msg = (file, line, code = "unsafe_code") => JSON.stringify({ reason: "compiler-message", message: { code: { code }, message: "usage of an `unsafe` block", spans: [{ is_primary: true, file_name: file, line_start: line }] } });
  const run = (...lines) => compilerSites([lines.join("\n")], found, "/repo/");
  ok(run(msg("x/src/lib.rs", 15)).errors.length === 0, "U1: a site inside a pinned item passes");
  ok(run(msg("x/src/lib.rs", 25)).errors.length === 1, "U1 refused: a site outside every pinned item");
  ok(run(msg("/repo/engine/target/debug/build/x-1/out/gen.rs", 3)).errors.some((e) => /generated code/.test(e)), "U1 refused: a site in a build script's OUT_DIR (in-tree target)");
  ok(run(msg("/tmp/t/debug/build/x-1/out/gen.rs", 3)).errors.some((e) => /generated code/.test(e)), "U1 refused: a site in an out-of-tree OUT_DIR");
  ok(run(msg("/home/u/.cargo/registry/src/x/lib.rs", 3)).errors.length === 0, "U1: a registry source site is the dependency's (outside the boundary)");
  ok(run(msg("x/src/lib.rs", 25, "dead_code")).errors.length === 0, "U1: other lints are ignored");
}

// and the real tree
const real = scan();
ok(real.errors.length === 0, `the tree scans clean (${real.found.length} allowed items)`);

console.log(failures ? `${failures} failures` : "unsafe inventory: all controls pass");
process.exit(failures ? 1 : 0);
