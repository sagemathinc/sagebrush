// ci: web-runner order=597 runner=bun
// The edit history published with a notebook ("Include edit history": history.js publishedHistory), and the share
// page's reading of one (readBundle with the player's bounds, replayHistory):
//   - its versions are the original's, in order, each at its own time, each notebook exactly docAt's;
//   - one anonymous writer: no original client id anywhere in it, in any field, payloads included;
//   - a cell whose text holds a writer's id, or looks like a patch id, is published as it is;
//   - read back within the bounds: a file that unpacks past the bound, a history past its count, or one holding
//     files is refused before anything of it is used; a well-formed one replays.
//   bun web/notebook/test-published-history.mjs
import { MemoryPatchStore } from "patchflow";
import { NotebookHistory, publishedHistory, replayHistory, readBundle, checkPublishedHistory } from "./history.js";
import { BUNDLE } from "./bundle.js";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const J = JSON.stringify;
const memHistory = (envs = []) => { const s = new MemoryPatchStore(envs); s.clear = async () => {}; return new NotebookHistory(s); };
const view = (d) => J({ mode: d.mode, cells: d.cells.map((c) => ({ id: c.id, type: c.type ?? "code", code: c.code })) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gzip = async (text) => new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

// ---- an original history: two writers (two sessions over one store), several versions
const store = new MemoryPatchStore();
store.clear = async () => {};
const a = new NotebookHistory(store), b = new NotebookHistory(store);
await a.init();
const docs = [];
const put = async (h, cells) => { const d = { mode: "python", cells }; h.record(d); docs.push(d); await sleep(3); };
await put(a, [{ id: "c1", code: "x = 1" }]);
await b.init();
const ids = new Set((await store.loadInitial()).patches.map((e) => e.time.slice(12)));
await put(b, [{ id: "c1", code: "x = 1" }, { id: "c2", code: "y = 2" }]);
const writerIds = [...new Set((await store.loadInitial()).patches.map((e) => e.time.slice(12)))];
// (a cell holding a writer's own id, and a string shaped like a patch id: content, kept as it is)
const tricky = `s = "${writerIds[0]}"  # 0000mwf7ifcx_${writerIds[writerIds.length - 1]}`;
await put(a, [{ id: "c1", code: tricky }, { id: "c2", code: "y = 2" }]);
await put(a, [{ id: "c1", code: tricky }, { id: "c2", code: "y = 3" }, { id: "c3", code: "print(x, y)", type: "code" }]);
const orig = memHistory((await store.loadInitial()).patches);
await orig.init();
const ov = orig.versions().filter((v) => v.time);
check(writerIds.length >= 1 && ov.length === 4, `the original: ${ov.length} versions, writers ${J(writerIds)} (${J([...ids])})`);

// ---- published
const pub = await publishedHistory(orig);
check(pub.versions === ov.length, `published: as many versions as the original (${pub.versions} of ${ov.length})`);
const text = J(pub.envs);
check(writerIds.every((w) => !pub.envs.some((e) => e.time.includes(w) || J(e.parents ?? []).includes(w))), "no original writer id in any patch id or parent");
check(pub.envs.every((e) => e.time.slice(12) === "S000000000000000" && e.userId === undefined && e.source === undefined), "one anonymous writer, no provenance fields");
check(!pub.envs.some((e) => e.meta?.journal), "no execution journal");
const replay = replayHistory(pub.envs);
await replay.init();
const rv = replay.versions().filter((v) => v.time);
check(rv.length === ov.length && rv.every((v, i) => v.ms === ov[i].ms), `each version at its own time: ${J(rv.map((v) => v.ms))} vs ${J(ov.map((v) => v.ms))}`);
check(rv.every((v, i) => view(replay.docAt(v.time)) === view(orig.docAt(ov[i].time))), "each version's notebook exactly the original's");
check(replay.docAt(rv[2].time).cells[0].code === tricky, "a cell holding a writer's id, or a patch-id-like string, published as it is: " + J(replay.docAt(rv[2].time).cells[0].code));
// (outside that cell's own text, no writer's id anywhere in the file: not in a payload, not in any field)
const outside = text.split(J(tricky).slice(1, -1)).join("").split(tricky).join("");
check(writerIds.every((w) => !outside.includes(w)), "outside that cell's text, no writer's id anywhere in the published history");

// ---- read back within the player's bounds
const LIMITS = { unpacked: 32 * 2 ** 20, history: 50_000, blobs: 0, blobBytes: 0, blobsBytes: 0 };
const bundle = (history, extra = {}) => J({ format: BUNDLE, version: 1, notebook: { name: "t", mode: "python", cells: [] }, history, blobs: {}, ...extra });
const good = await readBundle(await gzip(bundle(pub.envs)), LIMITS);
check(good.history.length === pub.envs.length, "a well-formed history is read");
const refused = async (bytes, limits, re, what) => { try { await readBundle(bytes, limits); check(false, what + ": not refused"); } catch (e) { check(re.test(String(e?.message ?? e)), `${what}: refused (${String(e?.message ?? e).slice(0, 90)})`); } };
// (a small gzip that unpacks past the bound: refused while unpacking, never all of it first)
await refused(await gzip(bundle(pub.envs) + " ".repeat(40 * 2 ** 20)), LIMITS, /at most 32 MiB unpacked/, "a file unpacking past 32 MiB");
await refused(await gzip(bundle(Array.from({ length: 60 }, () => pub.envs[0]))), { ...LIMITS, history: 50 }, /at most 50 changes/, "a history past its count");
await refused(await gzip(bundle(pub.envs, { blobs: { [ "a".repeat(64) ]: "AAAA" } })), LIMITS, /at most 0 files/, "a history holding files");
await refused(await gzip("not json at all"), LIMITS, /JSON|Unexpected|token/i, "a file that isn't a history");

// ---- well-formed before replay: malformed patches refused, saying which, before any is replayed
const malformed = (envs, re, what) => { try { checkPublishedHistory(envs); check(false, what + ": not refused"); } catch (e) { check(re.test(String(e?.message ?? e)), `${what}: refused (${String(e?.message ?? e).slice(0, 80)})`); } };
check(checkPublishedHistory(pub.envs) === pub.envs, "the published history is well formed");
malformed([...pub.envs, null], /change \d+: not an object/, "a null change");
malformed([{ ...pub.envs[0], time: "nope" }], /no patch id/, "a change without a patch id");
malformed([{ ...pub.envs[0], parents: Array.from({ length: 65 }, () => pub.envs[0].time) }], /its parents/, "a change with 65 parents");
malformed([{ ...pub.envs[0], parents: [{}] }], /its parents/, "a parent that isn't a patch id");
malformed([{ ...pub.envs[0], mergeParent: 7 }], /merge parent/, "a merge parent that isn't a patch id");
malformed({ length: 1 }, /not a history/, "not a list");

console.log(fails.length ? `FAIL ${fails.length} of ${checks}:\n  ` + fails.join("\n  ") : `ok: ${checks} checks`);
process.exit(fails.length ? 1 : 0);
