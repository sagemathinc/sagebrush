// Line 3's controls (scripts/line3-measure.mjs; line-3 case r4 §4 and §6, jointly frozen). Every control has a CLOSED
// expected outcome: the exact set of reasons printed, plus the stated pass/FAIL of each printed check. A bare
// non-zero exit is never evidence. A control whose own precondition fails stops with control-precondition, which is
// a broken control, never a verdict.
//   node scripts/test-line3-measure.mjs                       the fixtures (§6 G-2, the measure's fixtures, the pins):
//                                                             pure, no build; CI runs this
//   node scripts/test-line3-measure.mjs --pages DIR --trees BASE,PROD,DEV
//                                                             §4a/§4b on real pages: DIR holds prod-meas.html,
//                                                             dev-meas.html, prod-meas2.html, dev-meas2.html and
//                                                             env.json; PROD and DEV are the shipped web/ trees (their
//                                                             dist/index.html are the shipped pages), BASE the base
//                                                             PROD tree, for the real gate CLI (L-pin-bun)
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PINS, BASE_BLOCK, pinCheck, splitPage, tokens, rejoins, measurePair, checkLine3, gz } from "./line3-measure.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ts = createRequire(join(here, "..", "package.json"))("typescript-api");
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
let bad = 0;
const report = (name, ok, got) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got).slice(0, 400)}`); };
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const page = (js, head = "") => `<!doctype html><html><head>${head}</head><body><script>${js}</script></body></html>\n`;
const H = Array.from({ length: 8 }, (_, i) => createHash("sha256").update(`l3-ctl-${i}`).digest("hex")).join("");

// §6 G-2: the closed fixture table, the parser leaves expected exactly (full text, Identifier or not), each rejoined
const G2 = [
  ["G2-tmpl", "let a=`x${b}y`;", [["let", false], [" a", true], ["=", false], ["`x${", false], ["b", true], ["}y`", false], [";", false], ["", false]]],
  ["G2-nest", "let a=`p${`q${c}r`}s`;", [["let", false], [" a", true], ["=", false], ["`p${", false], ["`q${", false], ["c", true], ["}r`", false], ["}s`", false], [";", false], ["", false]]],
  ["G2-regex", "let r=/open/g,q=a/b/c;", [["let", false], [" r", true], ["=", false], ["/open/g", false], [",", false], ["q", true], ["=", false], ["a", true], ["/", false], ["b", true], ["/", false], ["c", true], [";", false], ["", false]]],
  ["G2-trivia", "/*!keep*/f( a ,//x\n b);", [["/*!keep*/f", true], ["(", false], [" a", true], [" ,", false], ["//x\n b", true], [")", false], [";", false], ["", false]]],
  ["G2-chain", "function open(){}function open2(){}open();open2();", [["function", false], [" open", true], ["(", false], ["", false], [")", false], ["{", false], ["", false], ["}", false], ["function", false], [" open2", true], ["(", false], ["", false], [")", false], ["{", false], ["", false], ["}", false], ["open", true], ["(", false], ["", false], [")", false], [";", false], ["open2", true], ["(", false], ["", false], [")", false], [";", false], ["", false]]],
  ["G2-private", "class A{#x=1;m(){return this.#x}}", [["class", false], [" A", true], ["{", false], ["#x", false], ["=", false], ["1", false], [";", false], ["m", true], ["(", false], ["", false], [")", false], ["{", false], ["return", false], [" this", false], [".", false], ["#x", false], ["}", false], ["}", false], ["", false]]],
];
function fixtures() {
  for (const [name, text, want] of G2) {
    const t = tokens(ts, text);
    const got = t.toks.map((x) => [x.full, x.id]);
    report(name, t.diagnostics === 0 && rejoins(t.toks, text) && JSON.stringify(got) === JSON.stringify(want), { diagnostics: t.diagnostics, got });
  }
  // the measure: accepted fixtures (exact fragment and pairs) and refusals (exact reason)
  const M = [
    { name: "accept: template substitution beside an insertion", prod: "let a=`x${b}y`;f(a);", dev: "let a=`x${b}y`;g(1);f(a);", fragment: "g(1);", pairs: [] },
    { name: "accept: a regex literal, then an insertion", prod: "let r=/a\\/b/g;f(r);", dev: "let r=/a\\/b/g;if(D)h(r);f(r);", fragment: "if(D)h(r);", pairs: [] },
    { name: "accept (r5): a comment kept as trivia", prod: "/*!keep*/f();", dev: "/*!keep*/f();g();", fragment: "g();", pairs: [] },
    { name: "refuse (r5): an insertion between a comment and its token", prod: "/*!keep*/f();", dev: "/*!keep*/g();f();", reason: "length" },
    { name: "accept: a division, not a regex", prod: "let q=a/b/c;f(q);", dev: "let q=a/b/c;g();f(q);", fragment: "g();", pairs: [] },
    { name: "accept (r4): renamed in one place, kept in another", prod: "a(b);c(b);", dev: "x(b);c(y);", fragment: "", pairs: [["a", "x", 1], ["b", "y", 1]] },
    { name: "accept (r5): the open/open2 chain", prod: "function open(){a}function open2(){b}open(1);open2(2);", dev: "function open2(){a}function open3(){b}open2(1);open3(2);function open(){c}open(3);", fragment: "function open(){c}open(3);", pairs: [["open", "open2", 2], ["open2", "open3", 2]] },
    { name: "refuse (r5): the misaligned chain", prod: "function open(){}function open2(){}open();open2();", dev: "function open(){}function open2(){}function open3(){}open2();open3();open();", reason: "length" },
    { name: "M-deletion", prod: "f();g();", dev: "f();", reason: "deletion" },
    { name: "M-non-identifier", prod: "f(1);", dev: "f(2);", reason: "non-identifier" },
    { name: "L-len", prod: "f(a,b);", dev: "f(c);", reason: "length" },
    { name: "L-incons (one PROD name two ways)", prod: "a(a);", dev: "x(y);", reason: "map-inconsistent" },
    { name: "L-incons-back (two PROD names to one)", prod: "a(b);", dev: "x(x);", reason: "map-inconsistent" },
    { name: "L-priv (M-private)", prod: "class A{#x=1;m(){return this.#x}}", dev: "class A{#y=1;m(){return this.#y}}", reason: "non-identifier" },
    { name: "M-parse", prod: "f();g();", dev: "f();)g();", reason: "parse" },
    { name: "M-html (outside the script)", prod: "f();", dev: "f();", head: "<meta x>", reason: "html-differs" },
  ];
  for (const c of M) {
    const r = measurePair(ts, page(c.prod), page(c.dev, c.head));
    let ok;
    if (c.reason) ok = !r.ok && r.reason === c.reason;
    else {
      ok = r.ok && r.rebuiltOk;
      if (ok && c.fragment !== undefined) ok = r.fragment.raw === Buffer.byteLength(c.fragment) && JSON.stringify(r.pairs) === JSON.stringify(c.pairs);
    }
    report(c.name, ok, r.ok ? { fragment: r.fragment, pairs: r.pairs, rebuiltOk: r.rebuiltOk } : { reason: r.reason, detail: r.detail });
  }
  // L-recon: the rejoin self-check refuses a token list with one token's text altered
  const text = "let a=`x${b}y`;f(a);", t = tokens(ts, text);
  const altered = t.toks.map((x, i) => (i === 1 ? { ...x, full: x.full + "z" } : x));
  report("L-recon", rejoins(t.toks, text) && !rejoins(altered, text), { clean: rejoins(t.toks, text), altered: rejoins(altered, text) });
  // L-pin-ts / L-pin-node / L-pin-zlib (and bun, beside the real-CLI L-pin-bun of --pages): pinCheck, one field changed
  for (const [name, field, value] of [["L-pin-bun (pinCheck)", "bun", "1.4.3"], ["L-pin-ts", "typescript", "5.9.2"], ["L-pin-node", "node", "v24.20.0"], ["L-pin-zlib", "zlib", "1.3.1"]]) {
    const r = pinCheck({ ...PINS, [field]: value });
    report(name, !r.ok && sameSet(Object.keys(r.detail), [field]), r);
  }
  report("pins: the pinned values pass", pinCheck({ ...PINS }).ok, PINS);
}

// §4a/§4b on real pages
function onPages(dir, trees) {
  const rd = (n) => readFileSync(join(dir, n));
  const [BASE, PROD, DEV] = trees.split(",");
  const base = {
    prodMeas: rd("prod-meas.html"), devMeas: rd("dev-meas.html"), prodMeas2: rd("prod-meas2.html"), devMeas2: rd("dev-meas2.html"),
    prodShip: readFileSync(join(PROD, "dist/index.html")), devShip: readFileSync(join(DEV, "dist/index.html")),
  };
  const env = JSON.parse(rd("env.json").toString("utf8"));
  const realEnv = { bun: env.bun, typescript: ts.version, node: process.version, zlib: process.versions.zlib };
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const before = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, sha(v)]));
  const lineOf = (r, check) => r.lines.find((l) => l.startsWith(`line 3 ${check} `)) ?? null;
  const status = (r, check) => { const l = lineOf(r, check); return l === null ? null : l.slice(`line 3 ${check} `.length).split(/[ :,]/)[0]; };
  const capHalves = (r) => { const l = lineOf(r, "cap"); if (!l) return null; const m = /cap raw \S+ (pass|FAIL), gzip \S+ (pass|FAIL)/.exec(l); return m ? [m[1], m[2]] : null; };
  // run one control: reasons must equal `want` exactly, `printed` maps a check to the status it must print
  const run = (name, pages, want, printed = {}, block = BASE_BLOCK) => {
    const r = checkLine3(ts, pages, realEnv, block);
    let ok = sameSet(r.reasons, want);
    for (const [c, s] of Object.entries(printed)) ok &&= c === "cap" ? JSON.stringify(capHalves(r)) === JSON.stringify(s) : status(r, c) === s;
    report(name, ok, { reasons: r.reasons, lines: r.lines.slice(2) });
    return r;
  };
  const precondition = (name, script, wantDiagnostics = false) => {
    const d = tokens(ts, script).diagnostics;
    if ((d > 0) !== wantDiagnostics) { bad++; console.log(`FAIL ${name}: control-precondition (parse diagnostics ${d})`); return false; }
    return true;
  };
  const D = splitPage(base.devMeas.toString("utf8")), P = splitPage(base.prodMeas.toString("utf8"));
  const devWith = (script) => Buffer.from(D.before + script + D.after, "utf8");
  const leaves = (() => { const sf = ts.createSourceFile("app.js", D.script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS); const out = []; const w = (n) => { const k = n.getChildren(sf); if (!k.length) { out.push({ n, start: n.getStart(sf), end: n.getEnd(), full: n.getFullText(sf), kind: n.kind, text: n.getText(sf) }); return; } k.forEach(w); }; w(sf); return out; })();
  const prodLeaves = tokens(ts, P.script).toks;
  let firstRun = 0; while (firstRun < prodLeaves.length && prodLeaves[firstRun].full === leaves[firstRun].full) firstRun++;
  const firstRunOffset = leaves[firstRun].start;
  // the clean run: PASS, no reason
  run("clean (the base block reproduces)", base, [], { "baseline-fragment": "pass", "xcheck-raw": "pass", "xcheck-gzip": "pass", cap: ["pass", "pass"] });
  // L-pin-bun through the REAL gate CLI (grader item 5)
  {
    const d = mkdtempSync(join(tmpdir(), "line3-pin-"));
    try {
      for (const n of ["prod-meas.html", "dev-meas.html", "prod-meas2.html", "dev-meas2.html"]) copyFileSync(join(dir, n), join(d, n));
      writeFileSync(join(d, "env.json"), JSON.stringify({ bun: "1.4.3" }));
      let out = "";
      try { out = execFileSync(process.execPath, [join(here, "site-asset-budget.mjs"), "--base-prod", BASE, "--prod", PROD, "--dev", DEV, "--prod-meas", join(d, "prod-meas.html"), "--dev-meas", join(d, "dev-meas.html"), "--prod-meas2", join(d, "prod-meas2.html"), "--dev-meas2", join(d, "dev-meas2.html"), "--env", join(d, "env.json")], { encoding: "utf8", maxBuffer: 1 << 26 }); }
      catch (e) { out = e.stdout ?? ""; }
      const l3 = out.split("\n").filter((l) => l.startsWith("line 3 "));
      const refused = l3.filter((l) => l.startsWith("line 3 REFUSED "));
      const metric = l3.filter((l) => /^line 3 (baseline-fragment|xcheck-raw|xcheck-gzip|cap|reasons) /.test(l));
      report("L-pin-bun (real CLI, --env bun 1.4.3)", refused.length === 1 && refused[0].startsWith("line 3 REFUSED pin: ") && refused[0].includes("1.4.3") && metric.length === 0 && /FAIL DEV bootstrap \(line 3\)/.test(out), { refused, metric });
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
  // L-det: the second DEV measuring page with one trailing space
  run("L-det", { ...base, devMeas2: Buffer.concat([base.devMeas2, Buffer.from(" ")]) }, ["determinism"]);
  // L-html: <title>Sagebrush -> <title>sagebrush (outside the app script)
  {
    const s = base.devMeas.toString("utf8"), a = "<title>Sagebrush";
    if (s.split(a).length !== 2 || D.script.includes(a)) { bad++; console.log("FAIL L-html: control-precondition (the title must occur once, outside the script)"); }
    else { const m = Buffer.from(s.replace(a, "<title>sagebrush"), "utf8"); run("L-html", { ...base, devMeas: m, devMeas2: m }, ["html-differs"]); }
  }
  const mutate = (name, script, want, printed = {}) => { const m = devWith(script); return run(name, { ...base, devMeas: m, devMeas2: m }, want, printed); };
  // L-parse: a `)` right after the first `;` token (it MUST produce diagnostics)
  {
    const semi = leaves.find((t) => t.kind === ts.SyntaxKind.SemicolonToken);
    const s = D.script.slice(0, semi.end) + ")" + D.script.slice(semi.end);
    if (semi.end < firstRunOffset && precondition("L-parse", s, true)) mutate("L-parse", s, ["parse"]);
    else if (semi.end >= firstRunOffset) { bad++; console.log("FAIL L-parse: control-precondition (not before the first inserted run)"); }
  }
  // L-del: the first `!` directly followed by a numeric literal with no trivia; the `!` deleted (grader item 1)
  {
    const k = leaves.findIndex((t, i) => t.kind === ts.SyntaxKind.ExclamationToken && leaves[i + 1] && leaves[i + 1].kind === ts.SyntaxKind.NumericLiteral && leaves[i + 1].full === leaves[i + 1].text);
    const t = leaves[k], s = D.script.slice(0, t.end - 1) + D.script.slice(t.end);
    console.log(`     L-del: token ${k}, script offset ${t.end - 1}, first inserted run at ${firstRunOffset}`);
    if (k < 0 || t.end >= firstRunOffset) { bad++; console.log("FAIL L-del: control-precondition (no such token before the first inserted run)"); }
    else if (precondition("L-del", s)) mutate("L-del", s, ["deletion"]);
  }
  // L-nonid: the first numeric-literal token `0` -> `1`
  {
    const z = leaves.find((t) => t.kind === ts.SyntaxKind.NumericLiteral && t.text === "0");
    const s = D.script.slice(0, z.end - 1) + "1" + D.script.slice(z.end);
    if (z.end >= firstRunOffset) { bad++; console.log("FAIL L-nonid: control-precondition (not before the first inserted run)"); }
    else if (precondition("L-nonid", s)) mutate("L-nonid", s, ["non-identifier"]);
  }
  // L-sem: every Identifier createElement -> l3SemFresh (consistent, injective, behaviour-changing)
  {
    if (base.prodMeas.includes("l3SemFresh") || base.devMeas.includes("l3SemFresh")) { bad++; console.log("FAIL L-sem: control-precondition (the fresh name occurs)"); }
    else {
      let out = "", last = 0;
      for (const t of leaves) if (t.kind === ts.SyntaxKind.Identifier && t.text === "createElement") { out += D.script.slice(last, t.start) + "l3SemFresh"; last = t.end; }
      const s = out + D.script.slice(last);
      if (precondition("L-sem", s)) mutate("L-sem", s, ["baseline-map"]);
    }
  }
  // L-count: the first PROD-equal Identifier `open` -> `open2` (x61 -> x62)
  {
    let ci = -1; for (let i = 0; i < firstRun; i++) if (leaves[i].kind === ts.SyntaxKind.Identifier && leaves[i].text === "open") { ci = i; break; }
    if (ci < 0) { bad++; console.log("FAIL L-count: control-precondition (no PROD-equal open before the first run)"); }
    else { const t = leaves[ci], s = D.script.slice(0, t.end) + "2" + D.script.slice(t.end); if (precondition("L-count", s)) mutate("L-count", s, ["baseline-count"]); }
  }
  // §4b: post-build mutations of the SHIPPED DEV page only; the measuring pages untouched (asserted)
  const shipped = (name, devShip, want, printed) => {
    run(name, { ...base, devShip }, want, printed);
    const now = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, sha(v)]));
    if (JSON.stringify(now) !== JSON.stringify(before)) { bad++; console.log(`FAIL ${name}: control-precondition (a measuring or base page changed)`); }
  };
  const S = splitPage(base.devShip.toString("latin1")), s0 = Buffer.byteLength(S.before, "latin1"), e0 = s0 + Buffer.byteLength(S.script, "latin1");
  shipped("L-raw", Buffer.concat([base.devShip.subarray(0, s0), Buffer.from("void 0;"), base.devShip.subarray(s0)]), ["xcheck-raw"], { "baseline-fragment": "pass", cap: ["pass", "pass"], "xcheck-gzip": "pass" });
  {
    const m = Buffer.from(base.devShip); Buffer.from(H.slice(0, 512)).copy(m, e0 - 512);
    shipped("L-gz", m, ["xcheck-gzip"], { "baseline-fragment": "pass", cap: ["pass", "pass"], "xcheck-raw": "pass" });
  }
  {
    // L-gz-hi: the 512-byte window of the app script with the largest own gzip (offsets 0, 64, ...; the first maximum), all 0x61
    let best = null; for (let i = s0; i + 512 <= e0; i += 64) { const k = gz(base.devShip.subarray(i, i + 512)); if (!best || k > best.k) best = { i, k }; }
    console.log(`     L-gz-hi: shipped DEV index.html sha256 ${sha(base.devShip)}, window at page offset ${best.i} (script offset ${best.i - s0}), own gzip ${best.k}`);
    const m = Buffer.from(base.devShip); m.fill(0x61, best.i, best.i + 512);
    if (m.length !== base.devShip.length) { bad++; console.log("FAIL L-gz-hi: control-precondition (length changed)"); }
    else shipped("L-gz-hi", m, ["xcheck-gzip"], { "baseline-fragment": "pass", cap: ["pass", "pass"], "xcheck-raw": "pass" });
  }
  // L-drop: the largest inserted run whose removal parses (ties: the earliest), removed from the DEV measuring script
  {
    const m0 = measurePair(ts, base.prodMeas.toString("utf8"), base.devMeas.toString("utf8"));
    const offsetOf = (tokIndex) => leaves.slice(0, tokIndex).reduce((n, t) => n + t.full.length, 0);
    const order = m0.runs.map((r) => ({ off: offsetOf(r.at), len: r.length })).sort((a, b) => b.len - a.len || a.off - b.off);
    const pick = order.find((r) => tokens(ts, D.script.slice(0, r.off) + D.script.slice(r.off + r.len)).diagnostics === 0);
    if (!pick) { bad++; console.log("FAIL L-drop: control-precondition (no run's removal parses)"); }
    else { console.log(`     L-drop: run at script offset ${pick.off}, ${pick.len} chars`); mutate("L-drop", D.script.slice(0, pick.off) + D.script.slice(pick.off + pick.len), ["baseline-fragment", "xcheck-raw", "xcheck-gzip"], { cap: ["pass", "pass"] }); }
  }
}

if (arg("--pages")) onPages(arg("--pages"), arg("--trees"));
else fixtures();
console.log(bad ? `FAIL: line 3 controls, ${bad} failed` : "ok: line 3 controls");
process.exit(bad ? 1 : 0);
