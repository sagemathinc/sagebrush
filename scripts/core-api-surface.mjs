#!/usr/bin/env node
// The Core API contract (plan-modular-packages-r4 §6): the public surface an
// optional package may use, with the feature level at which each name, type
// member and parameter appeared.  core-api-surface.json is generated from the
// built CLI and committed; src/pkgset.ts carries CORE_API and CORE_API_LEVEL.
//
//   node scripts/core-api-surface.mjs --check    (the default tier: fixed work, §6.3)
//   node scripts/core-api-surface.mjs --update   record additions at level + 1
//
// Public modules: the library's and bundled packages' modules with no part
// starting with "_", and public builtin modules; their non-underscore names;
// for each public class, its non-underscore members; signatures where the
// runtime has them (a compiled function's parameters), else "opaque".
// --check fails on any difference not recorded: an addition (record it with
// --update, which raises the level), a removal or an incompatible signature
// change (needs CORE_API's major bump or a reviewed core-api-changes.json
// entry).  A compatible expansion (new parameters with defaults) is recorded
// by --update with the new parameters at level + 1.  The work is one CLI run
// and one diff, however many package sets exist: no package metadata is read.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(root, "core-api-surface.json");
const LIMITS = { bytes: 2 * 1024 * 1024, entries: 50_000 };

// The public module names (top-level and their public submodules are found by the introspection)
function publicModules() {
  const out = new Set();
  const lib = join(root, "lib");
  // (and their public submodules, which a package may import, whether or
  // not the parent imports them itself: matplotlib.pyplot)
  const scan = (dir, prefix, depth) => {
    for (const f of readdirSync(dir)) {
      if (f.startsWith("_") || f.startsWith(".")) continue;
      if (f.endsWith(".py")) out.add(prefix + f.slice(0, -3));
      else if (statSync(join(dir, f)).isDirectory() && existsSync(join(dir, f, "__init__.py"))) {
        out.add(prefix + f);
        if (depth < 3) scan(join(dir, f), prefix + f + ".", depth + 1);
      }
    }
  };
  scan(lib, "", 0);
  const reg = JSON.parse(readFileSync(join(root, "packages", "registry.json"), "utf8"));
  for (const m of Object.keys(reg.modules)) if (!m.split(".").some((p) => p.startsWith("_"))) out.add(m);
  // (the public builtin modules, as src/runtime registers them)
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".ts")) for (const m of readFileSync(p, "utf8").matchAll(/newBuiltinModule\("([A-Za-z0-9_.]+)"/g)) if (!m[1].split(".").some((x) => x.startsWith("_"))) out.add(m[1]);
    }
  };
  walk(join(root, "src", "runtime"));
  return [...out].sort();
}

const INTROSPECT = String.raw`
import sys, json, types
mods = json.loads(MODS)
out = {"modules": {}, "failed": {}, "prefixes": set()}
import re
seg = re.compile(r"^(_[a-z][a-z0-9]*_)")
def note_private(n):
    m = seg.match(n)
    if m: out["prefixes"].add(m.group(1))
def params(f):
    c = getattr(f, "__code__", None)
    if c is None or not hasattr(c, "co_varnames"): return None
    names = list(c.co_varnames)
    argc, posonly, kwc, flags = c.co_argcount, c.co_posonlyargcount, c.co_kwonlyargcount, c.co_flags
    d = len(f.__defaults__ or ())
    kwd = f.__kwdefaults__ or {}
    ps = []
    for i in range(argc):
        ps.append({"name": names[i], "kind": "posonly" if i < posonly else "pos", "default": i >= argc - d})
    j = argc
    if flags & 4:
        ps.append({"name": names[j], "kind": "varargs", "default": True}); j += 1
    for i in range(kwc):
        n = names[j + i]
        ps.append({"name": n, "kind": "kwonly", "default": n in kwd})
    if flags & 8:
        ps.append({"name": names[j + kwc], "kind": "varkw", "default": True})
    return ps
def kind(v):
    if isinstance(v, type): return "class"
    if isinstance(v, types.ModuleType): return "module"
    if callable(v): return "function"
    return "constant"
def entry(v, with_members):
    k = kind(v)
    e = {"kind": k}
    if k == "function":
        p = params(v)
        e["params"] = p if p is not None else "opaque"
    if k == "class" and with_members:
        mem = {}
        for n in dir(v):
            if n.startswith("_"):
                note_private(n); continue
            try: a = getattr(v, n)
            except Exception: continue
            sub = {"kind": kind(a)}
            if sub["kind"] == "function":
                raw = v.__dict__.get(n, a) if hasattr(v, "__dict__") else a
                raw = getattr(raw, "__func__", raw)
                p = params(raw)
                sub["params"] = p if p is not None else "opaque"
            mem[n] = sub
        e["members"] = mem
    return e
seen = set()
def visit(name, depth):
    if name in seen or depth > 3: return
    seen.add(name)
    try:
        m = __import__(name)
        for part in name.split(".")[1:]: m = getattr(m, part)
    except BaseException as ex:
        out["failed"][name] = type(ex).__name__
        return
    names = {}
    for n in dir(m):
        if n.startswith("_"):
            note_private(n); continue
        try: v = getattr(m, n)
        except Exception: continue
        if isinstance(v, types.ModuleType):
            sub = getattr(v, "__name__", "")
            if sub == name + "." + n: visit(sub, depth + 1)
            continue
        names[n] = entry(v, getattr(v, "__module__", None) == name or isinstance(v, type))
    out["modules"][name] = {"names": names}
for n in mods: visit(n, 0)
out["prefixes"] = sorted(out["prefixes"])
print(json.dumps(out, sort_keys=True))
`;

function generate() {
  const cli = join(root, "build", "cli", "pyjs.cjs");
  if (!existsSync(cli)) throw new Error("needs the built CLI (node scripts/build-cli.mjs)");
  const tmp = mkdtempSync(join(tmpdir(), "sb-core-api-"));
  try {
    const py = join(tmp, "introspect.py");
    writeFileSync(py, "MODS = " + JSON.stringify(JSON.stringify(publicModules())) + "\n" + INTROSPECT);
    const text = execFileSync("node", [cli, py], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, SAGEBRUSH_NO_COMPILE_CACHE: "1" } });
    return JSON.parse(text);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Merge the generated surface into the recorded one: new names, members and
// parameters get `since = level` (the new level); returns {api, problems}
function merge(recorded, gen, newLevel) {
  const problems = [];
  const out = { format: "sagebrush-core-api", api: recorded?.api ?? 1, level: newLevel, prefixes: gen.prefixes, modules: {} };
  let added = 0;
  const sinceOf = (r, fallback) => (r && typeof r.since === "number" ? r.since : fallback);
  const mergeParams = (where, rp, gp, since) => {
    if (gp === "opaque" || rp === "opaque" || !Array.isArray(rp)) return gp === "opaque" ? "opaque" : gp.map((p) => ({ ...p, since }));
    // (an expansion: every recorded parameter unchanged and in place, the new ones with defaults)
    for (let i = 0; i < rp.length; i++) {
      const a = rp[i], b = gp[i];
      if (!b || a.name !== b.name || a.kind !== b.kind || a.default !== b.default) {
        problems.push(`${where}: parameter ${a.name} changed or removed (an incompatible signature change)`);
        return rp;
      }
    }
    const extra = gp.slice(rp.length);
    for (const p of extra) if (!p.default) problems.push(`${where}: new parameter ${p.name} has no default (an incompatible signature change)`);
    if (extra.length) added++;
    return [...rp, ...extra.map((p) => ({ ...p, since: newLevel }))];
  };
  const mergeEntry = (where, r, g) => {
    const since = sinceOf(r, newLevel);
    if (!r) added++;
    if (r && r.kind !== g.kind) problems.push(`${where}: its kind changed from ${r.kind} to ${g.kind}`);
    const e = { kind: g.kind, since };
    if (g.params !== undefined) e.params = mergeParams(where, r?.params, g.params, since);
    if (g.members !== undefined) {
      e.members = {};
      for (const [n, gm] of Object.entries(g.members)) e.members[n] = mergeEntry(`${where}.${n}`, r?.members?.[n], gm);
      for (const n of Object.keys(r?.members ?? {})) if (!Object.hasOwn(g.members, n)) problems.push(`${where}.${n}: removed`);
    }
    return e;
  };
  for (const [m, gm] of Object.entries(gen.modules)) {
    const rm = recorded?.modules?.[m];
    if (!rm) added++;
    const names = {};
    for (const [n, ge] of Object.entries(gm.names)) names[n] = mergeEntry(`${m}.${n}`, rm?.names?.[n], ge);
    for (const n of Object.keys(rm?.names ?? {})) if (!Object.hasOwn(gm.names, n)) problems.push(`${m}.${n}: removed`);
    out.modules[m] = { since: sinceOf(rm, newLevel), names };
  }
  for (const m of Object.keys(recorded?.modules ?? {})) if (!Object.hasOwn(gen.modules, m)) problems.push(`module ${m}: removed`);
  return { api: out, problems, added };
}

function countEntries(api) {
  let n = 0;
  for (const m of Object.values(api.modules)) for (const e of Object.values(m.names)) n += 1 + Object.keys(e.members ?? {}).length;
  return n;
}
const serialize = (api) => JSON.stringify(api, null, 0).replace(/},"/g, '},\n"') + "\n";
function pkgsetConstants() {
  const src = readFileSync(join(root, "src", "pkgset.ts"), "utf8");
  return { api: Number(/export const CORE_API = (\d+);/.exec(src)[1]), level: Number(/export const CORE_API_LEVEL = (\d+);/.exec(src)[1]) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const recorded = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : null;
  const consts = pkgsetConstants();
  const gen = generate();
  if (mode === "--update") {
    const level = recorded ? recorded.level + 1 : 1;
    const { api, problems, added } = merge(recorded, gen, level);
    if (problems.length) {
      console.error("not recorded: incompatible changes need CORE_API's major bump or a reviewed core-api-changes.json entry:\n  " + problems.join("\n  "));
      process.exit(1);
    }
    if (recorded && added === 0) {
      console.log(`core-api-surface.json is current (level ${recorded.level})`);
      process.exit(0);
    }
    api.level = recorded && added === 0 ? recorded.level : level;
    const text = serialize(api);
    if (text.length > LIMITS.bytes || countEntries(api) > LIMITS.entries) throw new Error(`the Core API surface is over its caps (${text.length} bytes, ${countEntries(api)} entries)`);
    writeFileSync(FILE, text);
    console.log(`core-api-surface.json: level ${api.level}, ${countEntries(api)} entries, ${text.length} bytes; set CORE_API_LEVEL = ${api.level} in src/pkgset.ts`);
    if (Object.keys(gen.failed).length) console.log("modules that could not be imported (left out): " + Object.keys(gen.failed).join(", "));
  } else if (mode === "--check") {
    if (!recorded) throw new Error("core-api-surface.json is missing (node scripts/core-api-surface.mjs --update)");
    const { problems, added } = merge(recorded, gen, recorded.level + 1);
    const errs = [...problems];
    if (added) errs.push(`${added} addition(s) to the Core API are not recorded: run node scripts/core-api-surface.mjs --update and set CORE_API_LEVEL`);
    if (consts.api !== recorded.api || consts.level !== recorded.level) errs.push(`src/pkgset.ts has CORE_API ${consts.api} level ${consts.level}; core-api-surface.json has ${recorded.api} level ${recorded.level}`);
    if (readFileSync(FILE, "utf8").length > LIMITS.bytes || countEntries(recorded) > LIMITS.entries) errs.push("core-api-surface.json is over its caps");
    if (errs.length) {
      console.error("the Core API contract check failed:\n  " + errs.join("\n  "));
      process.exit(1);
    }
    console.log(`Core API ${recorded.api} level ${recorded.level}: ${countEntries(recorded)} entries, unchanged`);
  } else {
    console.error("usage: core-api-surface.mjs --check | --update");
    process.exit(2);
  }
}
