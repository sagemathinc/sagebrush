// ci: checks.3 order=130
// The offline inventory's build-time controls (plan-b8-offline r3.4 §2-§3; cases K2, K3): every LAZY path in exactly
// one item, no paths or hashes in the inventory, a library group no rule places refused, and a catalog over each cap
// refused.  Run on a built web/dist (its sw.js LAZY and DIGESTS) and on synthetic lists.
//
//   bun web/build.ts && node web/test-offline-inventory.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OFFLINE_CAPS, itemOfGroup, itemCovers, checkStartCoverage, offlineInventory } from "./offline-inventory.mts";

let failures = 0;
const ok = (c, name) => (console.log((c ? "ok   " : "FAIL ") + name), c || failures++);
const refuses = (f, re) => { try { f(); return false; } catch (e) { return re.test(String(e)); } };
const here = new URL(".", import.meta.url).pathname;
const sw = readFileSync(join(here, "dist", "sw.js"), "utf8");
const literal = (name) => JSON.parse(new RegExp(`^const ${name} = (.*);$`, "m").exec(sw)[1]);
const LAZY = literal("LAZY"), DIGESTS = literal("DIGESTS");
const invText = readFileSync(join(here, "dist", "offline-inventory.json"), "utf8"), inv = JSON.parse(invText);

// K3: the built inventory partitions LAZY exactly, and names no path or hash
const CHUNK = /^lib\/([a-z0-9][a-z0-9-]*)\.(?:src|pre)\.[0-9a-f]{16}\.json$/;
const owner = (p) => {
  const hits = inv.items.filter((it) => it.rule === "engine" ? /^sagebrush-engine\.wasm/.test(p) : it.rule === "myst" ? p === "sagebrush-myst.js" : it.rule === "docs" ? /^docs-index(-[a-z]+)?\.json$/.test(p) : it.rule === "tzdata" ? p.startsWith("lib/tzdata/") : (it.groups ?? []).includes(CHUNK.exec(p)?.[1]));
  return hits.map((it) => it.id);
};
const owners = LAZY.map(owner);
ok(owners.every((o) => o.length === 1), `K3: each of the ${LAZY.length} LAZY paths is in exactly one item (${owners.filter((o) => o.length !== 1).length} not)`);
const files = Object.fromEntries(inv.items.map((it) => [it.id, owners.filter((o) => o[0] === it.id).length]));
ok(inv.items.every((it) => it.files === files[it.id] && it.files > 0), "K3: each item's file count is its paths' count, and none is empty");
const stored = Object.fromEntries(inv.items.map((it) => [it.id, LAZY.filter((_, i) => owners[i][0] === it.id).reduce((t, p) => t + DIGESTS[p.split("?")[0]].size, 0)]));
ok(inv.items.every((it) => it.stored === stored[it.id]), "K3: each item's stored bytes are its files' DIGESTS sizes");
ok(inv.totals.files === LAZY.length && inv.totals.stored === Object.values(stored).reduce((a, b) => a + b, 0), "K3: the totals are the sums");
ok(!/lib\/|\.json|\?h=|[0-9a-f]{16}/.test(invText), "K3: the inventory names no path and no hash");

// Hidden items (@sagebrush's ruling on #847, Nov 8; agents-ui's three points): the Rill and Sprig items are in the
// inventory, so every control above counts them, but each is hidden until the page can run its mode (Rill's A2,
// Sprig's S7), and the service worker drops a hidden item where it loads the inventory, so it is never listed, in
// "download all", or named as a new item
const hidden = inv.items.filter((it) => it.hidden === true);
ok(JSON.stringify(hidden.map((it) => it.id).sort()) === JSON.stringify(["rill", "sprig"]) && hidden.every((it) => it.groups.length > 0 && it.groups.every((g) => new RegExp(`^${it.id}(-|$)`).test(g))), "hidden: only the Rill and Sprig items, each still owning its own groups: " + JSON.stringify(hidden.map((it) => [it.id, it.groups])));
ok(inv.totals.files === inv.items.reduce((t, it) => t + it.files, 0), "hidden: the totals (and so the caps) still count the hidden item");
ok(/const inventory = \(\) => \(invP \?\?= invGet\(\)[\s\S]{0,400}inv\.items = inv\.items\.filter\(\(it\) => it\.hidden !== true\);/.test(sw), "hidden: sw.js's inventory() drops hidden items as it loads the inventory");
ok((sw.match(/\binvGet\(\)\./g) ?? []).length === 1 && (sw.match(/\binvGet\(/g) ?? []).length === 2, "hidden: inventory() is the one reader of the inventory in sw.js (ids(\"all\"), the keep record's new list, fetch and remove all go through it)");
const visible = inv.items.filter((it) => it.hidden !== true);
const allPaths = LAZY.filter((_, i) => visible.some((it) => it.id === owners[i][0]));
ok(allPaths.length > 0 && !allPaths.some((p) => /^lib\/(rill|sprig)/.test(p)), `hidden: "download all" over the visible items fetches no rill or sprig path (${allPaths.length} paths)`);
ok(!visible.some((it) => it.id === "rill" || it.id === "sprig"), "hidden: a new-items list over the visible items can't name Rill or Sprig");

// K2: a group no rule places, and each cap exceeded, are refused by the build
ok(refuses(() => itemOfGroup("brand-new-group"), /belongs to no item/), "K2: a library group no rule places is refused");
ok(itemOfGroup("core") === "python" && itemOfGroup("sci") === "scientific" && itemOfGroup("sage-x") === "sage" && itemOfGroup("pkg-foo") === "pkg-foo" && itemOfGroup("mod-bar") === "modules", "K2: the rules place the known groups");
const h = "0123456789abcdef";
const lazy = (n) => Array.from({ length: n }, (_, i) => `lib/core.src.${(h + i.toString(16)).slice(-16)}.json`);
const sizes = (ps, s) => new Map(ps.map((p) => [p, s]));
const build = (ps, s, t) => offlineInventory(ps, sizes(ps, s), sizes(ps, t));
ok(!refuses(() => build(lazy(OFFLINE_CAPS.files), 1, 1), /./), "K2: exactly the file cap passes");
ok(refuses(() => build(lazy(OFFLINE_CAPS.files + 1), 1, 1), /files >/), "K2: one file over the cap is refused");
ok(!refuses(() => build(lazy(4), OFFLINE_CAPS.stored / 4, 1), /./) && refuses(() => offlineInventory(lazy(4), new Map(lazy(4).map((p, i) => [p, OFFLINE_CAPS.stored / 4 + (i === 0 ? 1 : 0)])), sizes(lazy(4), 1)), /stored bytes >/), "K2: the stored cap: exactly passes, 1 byte over is refused");
ok(!refuses(() => build(lazy(2), 1, OFFLINE_CAPS.transfer / 2), /./) && refuses(() => offlineInventory(lazy(2), sizes(lazy(2), 1), new Map(lazy(2).map((p, i) => [p, OFFLINE_CAPS.transfer / 2 + i]))), /transfer bytes >/), "K2: the transfer cap: exactly passes, 1 byte over is refused");
ok(!refuses(() => build(lazy(1), OFFLINE_CAPS.maxEntry, 1), /./) && refuses(() => build(lazy(1), OFFLINE_CAPS.maxEntry + 1, 1), /an entry of/), "K2: the largest-entry cap: exactly passes, 1 byte over is refused");
ok(refuses(() => offlineInventory(["lib/core.src.0123456789abcdef.json", "lib/core.src.0123456789abcdef.json"], sizes(["lib/core.src.0123456789abcdef.json"], 1), sizes(["lib/core.src.0123456789abcdef.json"], 1)), /twice/), "K2: a path listed twice is refused");
ok(refuses(() => build(["something/else.bin"], 1, 1), /belongs to no item/), "K2: a LAZY path of no item is refused");
// (a mode's start fetches only groups its item holds or needs: what each item covers, and the build's check refusing a
// start that fetches another's group, naming the mode, the group and its item)
ok(itemCovers("sage", "sage") && itemCovers("sage", "python") && itemCovers("sage", "modules") && itemCovers("magma", "sage") && itemCovers("matlab", "scientific"),
  "an item covers itself and what it needs");
ok(!itemCovers("sage", "matlab") && !itemCovers("rill", "sage") && !itemCovers("python", "modules") && !itemCovers("matlab", "sage") && !itemCovers("nope", "python"),
  "an item covers nothing else: sage not matlab, rill not sage, python not modules, matlab not sage, an unknown item nothing");
ok(!refuses(() => checkStartCoverage({ matlab: ["core", "sci", "matlab", "mod-scipy"], magma: ["core", "sage", "magma-x", "mod-y"] }), /./),
  "a start that fetches only its own, its needs' and the modules' groups passes");
// (a package's group is an item of its own, which no mode's item needs: a start that fetched one would be refused)
ok(refuses(() => checkStartCoverage({ matlab: ["core", "matlab", "pkg-scipy-io"] }), /matlab's start fetches pkg-scipy-io, whose item pkg-scipy-io/),
  "a start that fetches a package's group is refused (each package is an item of its own)");
ok(refuses(() => checkStartCoverage({ sage: ["core", "sage", "matlab"] }), /sage's start fetches matlab, whose item matlab the sage item neither holds nor needs/),
  "a start that fetches another mode's group is refused, naming the mode, the group and its item");
ok(refuses(() => checkStartCoverage({ rill: ["core", "rill-a", "sage-ec"] }), /rill's start fetches sage-ec, whose item sage/),
  "...and rill's start fetching a sage group too");
console.log(failures ? `${failures} failure(s)` : "offline inventory: all controls pass");
process.exit(failures ? 1 : 0);
