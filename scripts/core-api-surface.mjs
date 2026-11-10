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
// entry).  A compatible expansion, one that keeps every existing call valid
// with its meaning (widenParams below), is recorded by --update with the new
// parameters at level + 1 (and a default given to a recorded parameter: its
// default_since, which keeps the shorter call in the contract, and makes
// removing that default later an incompatible change).  The work is one CLI run
// and one diff, however many package sets exist: no package metadata is read.
//
// core-api-changes.json: the reviewed incompatible signature changes, each
// {name, old, new, reason, pr}, old and new as signature() writes them.
// --update records exactly a listed change (the recorded signature is old,
// the generated one new) and nothing broader; --check fails on an entry the
// surface no longer needs (its function's recorded signature isn't new), so
// entries don't pile up.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(root, "core-api-surface.json");
const CHANGES = join(root, "core-api-changes.json");
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
# (a registry package's submodules: recorded only when its sagebrush.json declares them, python.modules, or when
# they are already recorded, so that nothing recorded is removed; @sagebrush's ruling, Nov 9: an internal module the
# introspection reaches is not a contract)
pkg_roots, keep = json.loads(PKG_MODS), set(json.loads(KEEP))
def undeclared(sub):
    return sub not in pkg_roots and sub not in keep and any(sub.startswith(r + ".") for r in pkg_roots)
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
    # (co_varnames in CPython's order: positional, keyword-only, then *args and **kwargs)
    j = argc + kwc
    if flags & 4:
        ps.append({"name": names[j], "kind": "varargs", "default": True}); j += 1
    for i in range(kwc):
        n = names[argc + i]
        ps.append({"name": n, "kind": "kwonly", "default": n in kwd})
    if flags & 8:
        ps.append({"name": names[j], "kind": "varkw", "default": True})
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
            if sub == name + "." + n and not undeclared(sub): visit(sub, depth + 1)
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
    // (the registry packages' declared modules, and the module names already recorded: see undeclared())
    const reg = JSON.parse(readFileSync(join(root, "packages", "registry.json"), "utf8"));
    const keep = existsSync(FILE) ? Object.keys(JSON.parse(readFileSync(FILE, "utf8")).modules) : [];
    writeFileSync(
      py,
      "MODS = " + JSON.stringify(JSON.stringify(publicModules())) + "\n" +
        "PKG_MODS = " + JSON.stringify(JSON.stringify(Object.keys(reg.modules).sort())) + "\n" +
        "KEEP = " + JSON.stringify(JSON.stringify(keep.sort())) + "\n" + INTROSPECT,
    );
    const text = execFileSync("node", [cli, py], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, SAGEBRUSH_NO_COMPILE_CACHE: "1" } });
    return JSON.parse(text);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// A signature widening is compatible exactly when every call valid against the
// recorded parameters stays valid and binds the same arguments to the same
// parameters:
//   - the recorded positional parameters keep their names, kinds and order, and
//     a default is never removed (one may be added);
//   - new positional parameters may only be appended, each with a default, and
//     only if there was no *args (else an extra positional argument would move
//     from *args to the new parameter);
//   - *args may be added, never removed;
//   - recorded keyword-only parameters stay keyword-only, with a default kept
//     where it existed; new ones need a default; their order doesn't matter;
//   - **kwargs may be added, never removed;
//   - and if there was a **kwargs, no new name a keyword can address: no new
//     positional-or-keyword or keyword-only parameter (f(a, **kw) ->
//     f(a, b=None, **kw) moves b out of kw in the old call f(1, b=2)).  A new
//     positional-only one is fine: a keyword b still goes to kw.
// So show(obj, **o) -> show(obj, *more, **o) is compatible; -> show(*objs, **o)
// is not (show(obj=x) would bind x into **o).  Returns the generated
// parameters, each with the recorded `since` where it existed and `newLevel`
// where it's new; `added`, true if anything new must be recorded: a new
// parameter, or a default given to a recorded one (the new shorter call: that
// parameter keeps its `since` and gets `default_since` = newLevel); and the
// problems found.
export function widenParams(where, rp, gp, newLevel) {
  const problems = [];
  const isPos = (p) => p.kind === "pos" || p.kind === "posonly";
  const rPos = rp.filter(isPos), gPos = gp.filter(isPos);
  const rVar = rp.find((p) => p.kind === "varargs"), gVar = gp.find((p) => p.kind === "varargs");
  const rKw = rp.filter((p) => p.kind === "kwonly"), gKw = gp.filter((p) => p.kind === "kwonly");
  const rVarKw = rp.find((p) => p.kind === "varkw"), gVarKw = gp.find((p) => p.kind === "varkw");
  const since = new Map();
  for (let i = 0; i < rPos.length; i++) {
    const a = rPos[i], b = gPos[i];
    if (!b || a.name !== b.name || a.kind !== b.kind || (a.default && !b.default)) {
      problems.push(`${where}: parameter ${a.name} changed or removed (an incompatible signature change)`);
      return { params: rp, problems, added: false };
    }
    since.set(b, a.since);
  }
  const newPos = gPos.slice(rPos.length);
  for (const p of newPos) {
    if (!p.default) problems.push(`${where}: new parameter ${p.name} has no default (an incompatible signature change)`);
    if (rVar) problems.push(`${where}: new positional parameter ${p.name} after *${rVar.name} (an extra positional argument would bind to it: incompatible)`);
  }
  if (rVar) {
    if (!gVar) problems.push(`${where}: *${rVar.name} removed (an incompatible signature change)`);
    else since.set(gVar, rVar.since);
  }
  for (const a of rKw) {
    const b = gKw.find((p) => p.name === a.name);
    if (!b || (a.default && !b.default)) problems.push(`${where}: keyword-only parameter ${a.name} changed or removed (an incompatible signature change)`);
    else since.set(b, a.since);
  }
  for (const p of gKw) if (!since.has(p) && !p.default) problems.push(`${where}: new keyword-only parameter ${p.name} has no default (an incompatible signature change)`);
  if (rVarKw) {
    if (!gVarKw) problems.push(`${where}: **${rVarKw.name} removed (an incompatible signature change)`);
    else since.set(gVarKw, rVarKw.since);
    for (const p of [...newPos, ...gKw]) {
      if (since.has(p) || p.kind === "posonly") continue;
      problems.push(`${where}: new parameter ${p.name} can be passed by keyword, which **${rVarKw.name} receives now (an existing call would rebind: incompatible)`);
    }
  }
  if (problems.length) return { params: rp, problems, added: false };
  // (the recorded parameter of each kept one, for its default)
  const recordedOf = new Map();
  for (let i = 0; i < rPos.length; i++) recordedOf.set(gPos[i], rPos[i]);
  for (const a of rKw) recordedOf.set(gKw.find((p) => p.name === a.name), a);
  let added = false;
  const params = gp.map((p) => {
    if (!since.has(p)) {
      added = true;
      return { ...p, since: newLevel };
    }
    const r = recordedOf.get(p), q = { ...p, since: since.get(p) };
    if (r?.default_since !== undefined) q.default_since = r.default_since;
    else if (r && p.default && !r.default) {
      added = true;
      q.default_since = newLevel;
    }
    return q;
  });
  return { params, problems, added };
}

// A parameter list as one line: (a, b=, /, *c, d=, **e); "opaque" as it is
export function signature(params) {
  if (!Array.isArray(params)) return String(params);
  const out = [];
  let star = params.some((p) => p.kind === "varargs");
  params.forEach((p, i) => {
    if (p.kind === "kwonly" && !star) { out.push("*"); star = true; }
    out.push((p.kind === "varargs" ? "*" : p.kind === "varkw" ? "**" : "") + p.name + (p.default ? "=" : ""));
    if (p.kind === "posonly" && params[i + 1]?.kind !== "posonly") out.push("/");
  });
  return "(" + out.join(", ") + ")";
}

// The reviewed changes (core-api-changes.json): their shape, or an error
export function readChanges(text) {
  const doc = JSON.parse(text);
  const list = doc?.changes;
  if (doc?.format !== "sagebrush-core-api-changes" || !Array.isArray(list)) throw new Error("core-api-changes.json: not {format: 'sagebrush-core-api-changes', changes: [...]}");
  for (const c of list) {
    const ok = c && typeof c.name === "string" && typeof c.old === "string" && typeof c.new === "string" && c.old !== c.new && typeof c.reason === "string" && c.reason && Number.isInteger(c.pr);
    // (a reviewed removal, upstream's: new "(absent)", old the removed entry's kind in parentheses, and the upstream
    // release that removed it; @sagebrush's ruling on P3b-1, Nov 7)
    const removal = c?.new === "(absent)";
    const okRemoval = !removal || (/^\([a-z]+\)$/.test(c.old) && typeof c.upstream === "string" && c.upstream !== "");
    if (!ok || !okRemoval) throw new Error(`core-api-changes.json: a bad entry ${JSON.stringify(c).slice(0, 200)}`);
  }
  if (new Set(list.map((c) => c.name)).size !== list.length) throw new Error("core-api-changes.json: two entries for one name");
  return list;
}

// The recorded entry of a dotted name (module.name, or module.Class.member), or undefined
function recordedEntry(api, name) {
  const m = Object.keys(api?.modules ?? {}).filter((k) => name.startsWith(k + ".")).sort((a, b) => b.length - a.length)[0];
  if (!m) return undefined;
  let e = { members: api.modules[m].names };
  for (const part of name.slice(m.length + 1).split(".")) {
    e = e?.members?.[part];
    if (!e) return undefined;
  }
  return e;
}

// Entries the recorded surface no longer needs: their function's signature isn't the entry's new one
export function staleChanges(recorded, changes) {
  const out = [];
  for (const c of changes) {
    const e = recordedEntry(recorded, c.name);
    const now = e ? signature(e.params) : "(absent)";
    if (now !== c.new) out.push(`core-api-changes.json: ${c.name} is not needed by the surface (recorded ${now}, the entry's new ${c.new}): remove the entry`);
  }
  return out;
}

// Merge the generated surface into the recorded one: new names, members and
// parameters get `since = level` (the new level); returns {api, problems}.
// `changes`: the reviewed incompatible changes, each applied only exactly.
export function merge(recorded, gen, newLevel, changes = []) {
  const problems = [];
  const out = { format: "sagebrush-core-api", api: recorded?.api ?? 1, level: newLevel, prefixes: gen.prefixes, modules: {} };
  let added = 0;
  const sinceOf = (r, fallback) => (r && typeof r.since === "number" ? r.since : fallback);
  const mergeParams = (where, rp, gp, since) => {
    if (gp === "opaque" || rp === "opaque" || !Array.isArray(rp)) return gp === "opaque" ? "opaque" : gp.map((p) => ({ ...p, since }));
    // (a reviewed incompatible change: exactly its old signature to exactly its new one)
    const c = changes.find((x) => x.name === where);
    if (c && signature(rp) === c.old && signature(gp) === c.new) {
      added++;
      return gp.map((p) => ({ ...p, since: newLevel }));
    }
    // (a compatible widening, or a problem: widenParams above)
    const w = widenParams(where, rp, gp, newLevel);
    problems.push(...w.problems);
    if (w.added) added++;
    return w.params;
  };
  // (a removed name or member: a problem, unless a reviewed removal names exactly it and its kind)
  // (applied, it is recorded in the surface's own "removed" section, {name: {kind, level}}, kept from then on: the
  // ledger the --check compares core-api-changes.json's removal entries with, exactly; @sagebrush's ruling on #830)
  out.removed = { ...(recorded?.removed ?? {}) };
  const removed = (where, r) => {
    if (changes.some((c) => c.new === "(absent)" && c.name === where && c.old === `(${r?.kind})`)) {
      added++;
      out.removed[where] = { kind: r.kind, level: newLevel };
    } else problems.push(`${where}: removed`);
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
      for (const n of Object.keys(r?.members ?? {})) if (!Object.hasOwn(g.members, n)) removed(`${where}.${n}`, r.members[n]);
    }
    return e;
  };
  for (const [m, gm] of Object.entries(gen.modules)) {
    const rm = recorded?.modules?.[m];
    if (!rm) added++;
    const names = {};
    for (const [n, ge] of Object.entries(gm.names)) names[n] = mergeEntry(`${m}.${n}`, rm?.names?.[n], ge);
    for (const n of Object.keys(rm?.names ?? {})) if (!Object.hasOwn(gm.names, n)) removed(`${m}.${n}`, rm.names[n]);
    out.modules[m] = { since: sinceOf(rm, newLevel), names };
  }
  for (const m of Object.keys(recorded?.modules ?? {})) if (!Object.hasOwn(gen.modules, m)) problems.push(`module ${m}: removed`);
  return { api: out, problems, added };
}

// Everything --check reports, for a recorded surface, the generated one, the
// reviewed changes and src/pkgset.ts's constants (the CLI's --check is this)
// (the removals ledger: core-api-changes.json's "(absent)" entries are exactly the surface's recorded removals, each
// with its old kind, and none of them is in the surface now; a wrong name or kind fails, grader's R1/R2 on #830)
export function ledgerErrors(recorded, changes) {
  const errs = [];
  const rec = recorded?.removed ?? {};
  const entries = changes.filter((c) => c.new === "(absent)");
  for (const c of entries) {
    const r = rec[c.name];
    if (!r) errs.push(`core-api-changes.json: the removal of ${c.name} is not one the surface recorded (its "removed" section has no ${c.name})`);
    else if (c.old !== `(${r.kind})`) errs.push(`core-api-changes.json: the removal of ${c.name} says ${c.old}, the surface recorded (${r.kind})`);
  }
  for (const [name, r] of Object.entries(rec)) {
    if (!entries.some((c) => c.name === name)) errs.push(`core-api-surface.json: the recorded removal of ${name} (${r.kind}) has no reviewed core-api-changes.json entry`);
    if (recordedEntry(recorded, name) !== undefined) errs.push(`core-api-surface.json: ${name} is recorded as removed but is in the surface`);
  }
  return errs;
}

export function checkErrors(recorded, gen, changes, consts, fileBytes) {
  const { problems, added } = merge(recorded, gen, recorded.level + 1, changes);
  const errs = [...problems, ...staleChanges(recorded, changes), ...ledgerErrors(recorded, changes)];
  if (added) errs.push(`${added} addition(s) or widening(s) of the Core API are not recorded: run node scripts/core-api-surface.mjs --update and set CORE_API_LEVEL`);
  if (consts.api !== recorded.api || consts.level !== recorded.level) errs.push(`src/pkgset.ts has CORE_API ${consts.api} level ${consts.level}; core-api-surface.json has ${recorded.api} level ${recorded.level}`);
  if (fileBytes > LIMITS.bytes || countEntries(recorded) > LIMITS.entries) errs.push("core-api-surface.json is over its caps");
  return errs;
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
  const changes = existsSync(CHANGES) ? readChanges(readFileSync(CHANGES, "utf8")) : [];
  if (mode === "--update") {
    const level = recorded ? recorded.level + 1 : 1;
    const { api, problems, added } = merge(recorded, gen, level, changes);
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
    const errs = checkErrors(recorded, gen, changes, consts, readFileSync(FILE, "utf8").length);
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
