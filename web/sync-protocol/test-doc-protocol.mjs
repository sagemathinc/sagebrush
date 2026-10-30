// The documents' sync protocol (doc-protocol.ts; plan-sync-slice2-r9.md §0a):
// its encodings against doc-vectors.json (made by an independent Python
// implementation, gen-doc-vectors.py), and its checks, each accepting what
// the plan allows and refusing what it doesn't.
//   bun web/sync-protocol/test-doc-protocol.mjs
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as P from "./doc-protocol.ts";
import * as R from "./protocol.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const throwsCode = (f, code, what) => {
  try {
    f();
    check(false, `${what}: didn't throw`);
  } catch (e) {
    check(e instanceof P.DocError && e.code === code, `${what}: ${e?.code ?? e} (wanted ${code})`);
  }
};
const here = new URL(".", import.meta.url).pathname;
const V = JSON.parse(readFileSync(here + "doc-vectors.json", "utf8"));
const td = new TextDecoder();

// ---- first, while this process is small: a 16 MiB string of U+0001 is refused without its escaped copy (LIMIT-PR62-1)
const child = Bun.spawnSync([process.execPath, "-e", `
  const P = await import(${JSON.stringify(here + "doc-protocol.ts")});
  const s = "\\u0001".repeat(16 << 20);
  let code = "none";
  try { P.jcs(s); } catch (e) { code = e.code; }
  console.log(JSON.stringify({ code, maxRSS: process.resourceUsage().maxRSS }));
`]);
const res = JSON.parse(new TextDecoder().decode(child.stdout).trim() || "{}");
check(res.code === "limit", `jcs: 16 MiB of U+0001 refused (${res.code})`);
// (run first, before this process grows: Linux carries a parent's max RSS into its child across fork and exec.
//  The string itself is 16 MiB; its escaped copy would be 96 MiB more, and the old path peaked near 177 MiB.)
check(res.maxRSS > 0 && res.maxRSS < 96 * 1024, `jcs: 16 MiB of U+0001 refused below the escaped copy's peak (max RSS ${res.maxRSS} KiB)`);


// ---- the refusals' vectors: each code one of protocol.ts's CODES, and each shape exactly as agreed (sync-docs, Oct 27)
{
  const J = JSON.stringify;
  const codes = new Set(R.CODES);
  check(codes.has("unavailable") && codes.size >= 18, "protocol.ts's Code has unavailable: " + [...codes].join(" "));
  check(Array.isArray(V.refusals) && V.refusals.length >= 3, "the refusals' vectors");
  for (const r of V.refusals ?? []) check(codes.has(r.error?.code), `refusal ${r.for}, ${r.when}: its code ${r.error?.code} is one of Code's`);
  const off = V.refusals?.find((r) => r.error?.code === "unavailable");
  check(off && off.error.detail?.why === "snapshots_off" && !("retry_after" in (off.error.detail ?? {})) && off.again === "never in this session", "snapshots off: unavailable, {why: snapshots_off}, no retry_after");
  const nat = (x) => Number.isSafeInteger(x) && x >= 0;
  const cads = (V.refusals ?? []).filter((r) => r.error?.detail?.limit === "snapshot_cadence");
  const fields = ["limit", "retry_after_batches", "retry_after_bytes", "retry_after_ms"];
  // (the rule: the server refuses unless (batches = 0 or bytes = 0) and ms = 0, so every refusal's fields break it)
  const allowed = (d) => (d.retry_after_batches === 0 || d.retry_after_bytes === 0) && d.retry_after_ms === 0;
  check(cads.length === 2 && cads.every((r) => r.error.code === "limit" && J(Object.keys(r.error.detail).sort()) === J(fields) && fields.slice(1).every((f) => nat(r.error.detail[f])) && !allowed(r.error.detail)), "the cadence: limit, snapshot_cadence, exactly retry_after_batches, retry_after_bytes and retry_after_ms, each refusal breaking the rule");
  check(cads.some((r) => r.error.detail.retry_after_batches === 0 && r.error.detail.retry_after_ms > 0), "…and one with only the hour left (history met): the rule is AND, not any");
  const conf = (V.refusals ?? []).filter((r) => r.error?.code === "conflict");
  check(conf.length === 2 && conf.some((r) => !("detail" in r.error)) && conf.some((r) => J(Object.keys(r.error.detail ?? {})) === J(["latest_at_seq"]) && nat(r.error.detail.latest_at_seq)), "conflict: bare for another digest at a taken at_seq; {latest_at_seq} for one at or before the latest");
  check(V.refusals.length === 5, "the five snapshot refusals");
  check(J(Object.keys(off.error.detail)) === J(["why"]), "snapshots off: exactly {why}");
  // (every vector's refusal is what a client of this build reads: its code kept, as is)
  for (const r of V.refusals ?? []) { const e = R.refusalOf({ ...r.error, message: "m" }); check(e.code === r.error.code && J(e.detail ?? null) === J(r.error.detail ?? null), `refusal ${r.error.code}: read as itself`); }
}
// ---- the answers' shapes (sync-docs and sync-client, Oct 28): each well formed, its codes Code's, and the checker
// accepting a frame of the shape and refusing a key too many, one missing, a wrong type and a wrong literal
{
  const J = JSON.stringify;
  const A = V.answers ?? [];
  check(A.length === 6 && J(A.map((a) => a.for)) === J(["pull", "batch", "batch", "batch", "pull", "doc_claim"]), "the six answers' vectors: " + J(A.map((a) => a.for)));
  const named = new Set(["number", "string", "boolean", "null", "string|null", "array"]);
  const wellFormed = (s) => typeof s === "string" ? (s.startsWith("=") || named.has(s)) : Array.isArray(s) ? s.length === 1 && wellFormed(s[0]) : !!s && typeof s === "object" && Object.values(s).every(wellFormed);
  for (const a of A) check(wellFormed(a.shape) && typeof a.when === "string", `answer ${a.for}, ${a.when}: a well-formed shape`);
  for (const a of A.filter((x) => x.shape?.t === "=error")) check(R.isCode(a.shape.code.slice(1)) && "message" in a.shape.detail, `answer ${a.for}, ${a.when}: its code is Code's, and detail has message`);
  const by = (f, w) => A.find((a) => a.for === f && a.when.startsWith(w))?.shape;
  const head = { epoch: 1, seq: 2, chain: "ab".repeat(32) };
  const ack = { t: "ack", req: 3, batch: { seq: 2, new: 1, resent: {}, head } };
  check(P.shapeMismatch(ack, by("batch", "a new patch")) === null, "shapes: a new batch's ack matches");
  check(P.shapeMismatch({ t: "ack", req: 4, batch: { new: 0, resent: { ["0".repeat(11) + "_c"]: 2 }, head } }, by("batch", "every patch a resend")) === null, "shapes: an all-resent ack (no seq) matches");
  check(/seq: not in the shape/.test(P.shapeMismatch({ ...ack, batch: { ...ack.batch, new: 0 } }, by("batch", "every patch a resend")) ?? ""), "shapes: an all-resent ack with a seq is refused");
  check(/resent: not an object/.test(P.shapeMismatch({ ...ack, batch: { ...ack.batch, resent: 1 } }, by("batch", "a new patch")) ?? ""), "shapes: resent as a count is refused");
  check(/head\.chain: missing/.test(P.shapeMismatch({ ...ack, batch: { ...ack.batch, head: { epoch: 1, seq: 2 } } }, by("batch", "a new patch")) ?? ""), "shapes: a head without its chain is refused");
  const page = { t: "batches", req: 5, owner: "f".repeat(64), doc: "0123456789ab", epoch: 1, head: { ...head, chain: null }, items: [{ seq: 1, author: "person", writer: "session:d", device: "d", recv: 1, chain: null, patches: [], body: "" }], more: false };
  check(P.shapeMismatch(page, by("pull", "a page")) === null && P.shapeMismatch({ ...page, items: [] }, by("pull", "a page")) === null, "shapes: a page (and an empty one) matches, null chains too");
  check(/snapshot: not in the shape/.test(P.shapeMismatch({ ...page, snapshot: { at_seq: 1 } }, by("pull", "a page")) ?? ""), "shapes: a page with a snapshot key is refused");
  check(/items\[0\]\.device: missing/.test(P.shapeMismatch({ ...page, items: [{ ...page.items[0], device: undefined }].map(({ device, ...x }) => x) }, by("pull", "a page")) ?? ""), "shapes: an item without its device is refused");
  // (daybreak4's item 4 review: a value of the wrong named type, a map's value of the wrong type, and a non-array
  // where the shape is an array are each refused, so each of those three guards has a fixture that fails without it)
  check(/\$\.req: not number/.test(P.shapeMismatch({ ...ack, req: "3" }, by("batch", "a new patch")) ?? ""), "shapes: a req that is a string, not a number, is refused");
  check(/resent\.0{11}_c: not number/.test(P.shapeMismatch({ t: "ack", req: 4, batch: { new: 0, resent: { ["0".repeat(11) + "_c"]: "2" }, head } }, by("batch", "every patch a resend")) ?? ""), "shapes: a resent map's value that is a string, not a number, is refused");
  check(/\$\.items: not an array/.test(P.shapeMismatch({ ...page, items: { 0: page.items[0] } }, by("pull", "a page")) ?? ""), "shapes: items as an object, not an array, is refused");
  // (astra's item 4 review: A2, a map's later value of the wrong type after valid ones; A1, a frame's own extra key that
  // Object.prototype also has, from JSON as a peer would send it, is not in the shape; a shape's required key is the
  // frame's own; a shape naming a prototype property names no type)
  const ids = ["0".repeat(11) + "_a", "0".repeat(11) + "_b", "0".repeat(11) + "_c"];
  check(P.shapeMismatch({ t: "ack", req: 4, batch: { new: 0, resent: { [ids[0]]: 1, [ids[1]]: 2, [ids[2]]: 3 }, head } }, by("batch", "every patch a resend")) === null, "shapes: a resent map of three numbers matches (the control for the next two)");
  check(/resent\.0{11}_c: not number/.test(P.shapeMismatch({ t: "ack", req: 4, batch: { new: 0, resent: { [ids[0]]: 1, [ids[1]]: 2, [ids[2]]: "3" }, head } }, by("batch", "every patch a resend")) ?? ""), "shapes: a resent map whose third value is a string, after two numbers, is refused at that value");
  check(/resent\.0{11}_c: not number/.test(P.shapeMismatch({ t: "ack", req: 4, batch: { new: 0, resent: { [ids[0]]: 1, [ids[1]]: 2, [ids[2]]: {} }, head } }, by("batch", "every patch a resend")) ?? ""), "shapes: a resent map whose third value is an object, after two numbers, is refused at that value");
  check(/items\[0\]\.patches: not array/.test(P.shapeMismatch({ ...page, items: [{ ...page.items[0], patches: {} }] }, by("pull", "a page")) ?? ""), "shapes: an item whose patches is an object, not an array (the named \"array\" type), is refused");
  check(/\$\.more: not boolean/.test(P.shapeMismatch({ ...page, more: 0 }, by("pull", "a page")) ?? ""), "shapes: a page whose more is 0, not a boolean, is refused");
  check(/the shape names no type \(integer\)/.test(P.shapeMismatch(1, "integer") ?? ""), "shapes: an unknown type name names no type");
  for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const frame = JSON.parse(J(ack).slice(0, -1) + `,${J(k)}:1}`);
    check(new RegExp(`\\$\\.${k}: not in the shape`).test(P.shapeMismatch(frame, by("batch", "a new patch")) ?? ""), `shapes: an ack with its own extra key ${k} (from JSON) is refused`);
  }
  check(/\$\.toString: missing/.test(P.shapeMismatch({}, { toString: "number" }) ?? ""), "shapes: a required key the frame has only on its prototype is missing");
  check(/the shape names no type \(toString\)/.test(P.shapeMismatch(1, "toString") ?? ""), "shapes: a shape naming Object.prototype's toString names no type");
  const ep = { t: "error", req: 6, code: "epoch", detail: { message: "m", epoch: 2, head: { epoch: 2, seq: 1 } } };
  check(P.shapeMismatch(ep, by("batch", "another epoch")) === null && P.shapeMismatch(ep, by("pull", "another epoch")) === null, "shapes: the cleared history's refusal matches, for batch and pull");
  check(/code: not "stale_epoch"/.test(P.shapeMismatch(ep, by("doc_claim", "another epoch")) ?? ""), "shapes: a claim's other epoch is stale_epoch, not epoch");
}
// ---- merge modes (plan-merge-align r3.2 §2-§3): the vectors (gen-doc-vectors.py, an independent implementation) against
// doc-protocol.ts's helloMerge, creationMode, mergeAdmits and checkDocClaim; merge_mode is a Code; its answers' shapes
{
  const J = JSON.stringify;
  const M = V.merge ?? {};
  check(J(M.modes) === J(P.MERGE_MODES), "merge: the modes, as the vectors: " + J(M.modes));
  check((M.hello ?? []).length === 16 && (M.creation ?? []).length === 24 && (M.admits ?? []).length === 8 && (M.claims ?? []).length === 6, "merge: every vector there");
  const out = (f) => { try { return [...f()].sort(); } catch (e) { return e?.code === "invalid" ? "invalid" : "threw " + e; } };
  for (const h of M.hello ?? []) {
    const got = out(() => P.helloMerge(h.absent ? undefined : h.in));
    check(J(got) === J(h.out), `merge: hello ${h.absent ? "(absent)" : J(h.in).slice(0, 60)} -> ${J(h.out)}: ${J(got)}`);
  }
  for (const c of M.creation ?? []) {
    const got = P.creationMode({ exactOn: c.exact_on, runs: new Set(c.runs), ...(c.asked ? { asked: c.asked } : {}) });
    check(got === c.out, `merge: made with the switch ${c.exact_on ? "on" : "off"}, runs ${J(c.runs)}, asked ${c.asked ?? "(nothing)"} -> ${c.out}: ${got}`);
  }
  check((M.creation ?? []).filter((c) => c.out === "exact-v1").length === 2, "merge: exact-v1 only with the switch on, a socket that runs it and asked for (2 of 24)");
  for (const x of M.admits ?? []) check(P.mergeAdmits(x.mode, new Set(x.runs)) === x.out, `merge: ${x.mode} admitted to ${J(x.runs)}: ${x.out}`);
  for (const c of M.claims ?? []) {
    let ok = true, merge;
    try { merge = P.checkDocClaim(c.in).merge; } catch { ok = false; }
    check(ok === c.ok && (!ok || merge === c.in.merge), `merge: a claim with merge ${J(c.in.merge)}: ${c.ok ? "taken" : "refused"}`);
  }
  check(J(P.checkDocClaim({ t: "doc_claim", req: 1, doc: "0123456789ab", epoch: 1, client: "c1" })) === J({ t: "doc_claim", req: 1, epoch: 1, client: "c1", doc: "0123456789ab" }), "merge: a claim without merge is as before (no merge key)");
  check(R.isCode("merge_mode") && (M.refusals ?? []).every((r) => R.isCode(r.error.code)), "merge: merge_mode is a Code");
  const e = R.refusalOf({ code: "merge_mode", message: "m", detail: { merge: "exact-v1" } });
  check(e.code === "merge_mode" && e.detail?.merge === "exact-v1", "merge: merge_mode read as itself, with the document's mode");
  const A = M.answers ?? [];
  const by = (f, w) => A.find((a) => a.for === f && a.when.startsWith(w))?.shape;
  const claim = { client: "c1", fgen: 0, next_cseq: 1 };
  check(P.shapeMismatch({ t: "ack", req: 1, claim: { ...claim, merge: "exact-v1" } }, by("doc_claim", "to a socket whose hello said")) === null, "merge: a claim's ack with merge, to a socket that said merge");
  check(P.shapeMismatch({ t: "ack", req: 1, claim }, by("doc_claim", "to a socket whose hello didn't")) === null, "merge: a claim's ack, to an older socket, as before");
  check(/merge: not in the shape/.test(P.shapeMismatch({ t: "ack", req: 1, claim: { ...claim, merge: "legacy" } }, by("doc_claim", "to a socket whose hello didn't")) ?? ""), "merge: an older socket's claim ack never carries merge");
  for (const f of ["doc_claim", "pull", "batch"]) check(P.shapeMismatch({ t: "error", req: 2, code: "merge_mode", detail: { message: "m", merge: "exact-v1" } }, by(f, "the document's mode")) === null, `merge: ${f}'s merge_mode refusal`);
}
// ---- a refusal with a code this build doesn't know fails closed: "invalid", final, its code kept (daybreak3's U2)
{
  const J = JSON.stringify;
  check(J([...R.CODES].sort()) === J([...new Set(R.CODES)].sort()) && R.CODES.length === 19 && R.isCode("unavailable") && R.isCode("merge_mode") && !R.isCode("brand_new") && !R.isCode(5), "protocol.ts's CODES at runtime, and isCode");
  let got = null;
  try { R.unwrap({ error: { code: "brand_new", message: "from a newer server", detail: { retry_after: 5 } } }); } catch (e) { got = e; }
  check(got instanceof R.SyncError && got.code === "invalid" && got.detail?.unknown_code === "brand_new" && got.detail?.final === true && !("retry_after" in got.detail), "an unknown code: invalid, final, no retry_after kept: " + J(got?.detail));
  let got2 = null;
  try { R.unwrap({ error: { code: 7 } }); } catch (e) { got2 = e; }
  check(got2?.code === "invalid" && got2.detail?.unknown_code === null, "a code that isn't a string: invalid too");
  let got3 = null;
  try { R.unwrap({ error: { code: "limit", message: "x", detail: { limit: "snapshot_cadence" } } }); } catch (e) { got3 = e; }
  check(got3?.code === "limit" && got3.detail?.limit === "snapshot_cadence", "a known code: as it was");
}

// ---- the encodings, against the vectors

for (const t of V.sha256) check(P.hex(P.sha256(P.fromHex(t.hex_in))) === t.out, `sha256 of ${t.hex_in.length / 2} bytes`);
// (and against node's, on sizes around every block boundary)
for (let n = 0; n < 300; n++) {
  const b = new Uint8Array(n).map((_, i) => (i * 31 + n) & 255);
  check(P.hex(P.sha256(b)) === createHash("sha256").update(b).digest("hex"), `sha256 of ${n} bytes, against node's`);
}
for (const t of V.enc) check(P.hex(P.enc(t.in)) === t.out, `enc ${JSON.stringify(t.in)}`);
for (const t of V.u64) check(P.hex(P.u64(t.in)) === t.out, `u64 ${t.in}`);
throwsCode(() => P.u64(-1), "invalid", "u64 of -1");
throwsCode(() => P.u64(2 ** 53), "invalid", "u64 past safe integers");
for (const t of V.jcs) check(P.jcs(t.in) === t.out, `jcs ${t.out}`);
// (RFC 8785's IEEE-754 cases, as bits: the oracle and the TypeScript agree, and so does JSON.stringify: CORR-PR62-1)
check(V.jcs_numbers.length >= 35, "the number vectors");
for (const t of V.jcs_numbers) {
  const dv = new DataView(new ArrayBuffer(8));
  for (let i = 0; i < 8; i++) dv.setUint8(i, parseInt(t.bits.slice(2 * i, 2 * i + 2), 16));
  const x = dv.getFloat64(0);
  check(P.jcs(x) === t.out, `jcs of the double ${t.bits}: ${P.jcs(x)}, wanted ${t.out}`);
  check(JSON.stringify(x) === t.out, `JSON.stringify parity on ${t.bits}`);
}
for (const s of V.jcs_invalid) throwsCode(() => P.jcs(JSON.parse(s)), "invalid_value", `jcs refuses ${s}`);
throwsCode(() => P.jcs({ a: NaN }), "invalid_value", "jcs refuses NaN");
throwsCode(() => P.jcs({ a: Infinity }), "invalid_value", "jcs refuses Infinity");
throwsCode(() => P.jcs(new Date(0)), "invalid_value", "jcs refuses a non-plain object");

// the chain
const cs = V.chain_seed;
check(P.hex(P.chainSeed(cs.owner_hash, cs.doc, cs.epoch)) === cs.out, "chain seed");
let prev = P.chainSeed(cs.owner_hash, cs.doc, cs.epoch);
const batches = V.chain.map((b) => ({ ...b, body: P.fromHex(b.body_hex) }));
for (const b of batches) {
  const hb = P.batchHash(b.envs, b.body);
  check(P.hex(hb) === b.hb, `h_b of batch ${b.seq}`);
  prev = P.chainNext(prev, { ...b, hb });
  check(P.hex(prev) === b.chain, `chain at ${b.seq}`);
}
const last = batches[batches.length - 1].chain;
const vc = (bs, extra = {}) => P.verifyChain({ ownerHash: cs.owner_hash, doc: cs.doc, epoch: 1, upto: bs.length, expect: bs.length ? bs[bs.length - 1].chain : P.hex(P.chainSeed(cs.owner_hash, cs.doc, 1)), ...extra }, bs);
check(vc(batches).ok, "verifyChain: the vectors' prefix");
check(vc(batches.slice(0, 2)).ok, "verifyChain: a shorter prefix");
check(vc([]).ok, "verifyChain: the empty prefix is the seed");
check(!vc([batches[0], batches[2]]).ok, "verifyChain: a gap");
check(!vc([batches[1], batches[0], batches[2]]).ok, "verifyChain: a reordering");
check(!vc(batches.map((b, i) => (i === 1 ? { ...b, body: new Uint8Array([1]) } : b))).ok, "verifyChain: a changed body");
check(!vc(batches.map((b, i) => (i === 1 ? { ...b, author: "other" } : b))).ok, "verifyChain: a changed author");
check(!vc(batches.map((b, i) => (i === 2 ? { ...b, recv: 999 } : b))).ok, "verifyChain: recv going back");
check(!vc(batches.map((b, i) => (i === 0 ? { ...b, epoch: 2 } : b))).ok, "verifyChain: another epoch");
check(!vc(batches, { deadline: 2500 }).ok, "verifyChain: a batch at the deadline is late");
check(vc(batches, { deadline: 2501 }).ok, "verifyChain: all before the deadline");
check(!vc(batches, { expect: "00".repeat(32) }).ok, "verifyChain: a different collection chain");
check(!P.verifyChain({ ownerHash: cs.owner_hash, doc: cs.doc, epoch: 1, upto: 3, expect: last }, batches.slice(0, 2)).ok, "verifyChain: fewer batches than upto");

// the sealed value and the census
for (const s of V.sealed) {
  const b = P.sealedValueBytes(s.kind, s.records);
  check(td.decode(b) === s.text, `sealed ${s.kind}: bytes`);
  check(P.sha256Hex(b) === s.sha256, `sealed ${s.kind}: sha256`);
  const cells = P.censusOf(s.kind, s.records);
  check(JSON.stringify(cells) === JSON.stringify(s.census), `census ${s.kind}`);
  const cb = P.censusBytes(cells);
  check(td.decode(cb) === s.census_text && P.sha256Hex(cb) === s.census_sha256, `census ${s.kind}: bytes`);
  check(JSON.stringify(P.parseCensus(cb)) === JSON.stringify(cells), `census ${s.kind}: parsed back`);
  // (insertion order never matters)
  check(P.sha256Hex(P.sealedValueBytes(s.kind, [...s.records].reverse())) === s.sha256, `sealed ${s.kind}: any record order`);
  const shuffled = s.records.map((r) => Object.fromEntries(Object.entries(r).reverse()));
  check(P.sha256Hex(P.sealedValueBytes(s.kind, shuffled)) === s.sha256, `sealed ${s.kind}: any property order`);
}
const nb = V.sealed[0].records;
throwsCode(() => P.sealedValueBytes("notebook", [...nb, { type: "cell", id: "c2", pos: 9, input: "", cell_type: "code" }]), "invalid_value", "sealed: two cells with one id");
throwsCode(() => P.sealedValueBytes("notebook", [{ type: "cell", id: "x", pos: NaN, input: "", cell_type: "code" }]), "invalid_value", "sealed: a non-finite number");
throwsCode(() => P.sealedValueBytes("notebook", [{ type: "cell", id: "x", pos: 0, input: "\ud800", cell_type: "code" }]), "invalid_value", "sealed: a lone surrogate");
throwsCode(() => P.sealedValueBytes("notebook", [{ type: "cell", id: "x", pos: 0, input: "x".repeat(16 << 20), cell_type: "code" }]), "limit", "sealed: over 16 MiB");
const many = Array.from({ length: 2001 }, (_, i) => ({ id: "c" + String(i).padStart(5, "0"), cell_type: "code" }));
throwsCode(() => P.censusBytes(many), "invalid_value", "census: over 2,000 cells");
check(P.censusBytes(many.slice(0, 2000)).length <= 256 << 10, "census: 2,000 cells fit 256 KiB");
throwsCode(() => P.censusBytes([{ id: "b", cell_type: "code" }, { id: "a", cell_type: "code" }]), "invalid", "census: out of order");
throwsCode(() => P.parseCensus(P.utf8("sb-sync-census-v1\n{\"id\":\"a\",\"cell_type\":\"code\"}\n")), "invalid", "census: not canonical (key order)");
throwsCode(() => P.parseCensus(P.utf8("sb-sync-census-v1")), "invalid", "census: no final newline");
check(P.parseCensus(P.utf8("sb-sync-census-v1\n")).length === 0, "census: the empty census");

// the outputs digest and the final descriptor
for (const t of V.outputs_digest) check(P.outputsDigest(t.entries) === t.out, `outputs digest of ${t.entries.length} cells`);
const E = V.outputs_digest[0].entries;
const digestOf = (mut) => P.outputsDigest(mut(structuredClone(E)));
check(digestOf((e) => ((e[5].state = "not_run"), e)) !== V.outputs_digest[0].out, "digest: a state changes it");
check(digestOf((e) => ((e[2].full.rev = 4), e)) !== V.outputs_digest[0].out, "digest: a blob's rev changes it");
check(digestOf((e) => ((e[3].preview.kind = "text"), e)) !== V.outputs_digest[0].out, "digest: a preview's kind changes it");
check(digestOf((e) => ((e[4].preview.sha256 = "e".repeat(64)), e)) !== V.outputs_digest[0].out, "digest: a preview's blob changes it");
throwsCode(() => P.outputsDigest([E[1], E[0]]), "invalid", "digest: cells out of order");
throwsCode(() => P.outputsDigest([{ cell: "x", state: "not_run", full: E[2].full }]), "invalid", "digest: a blob on a cell that isn't captured");
throwsCode(() => P.outputsDigest([{ cell: "x", state: "captured" }]), "invalid", "digest: a captured cell with no blob");
const census = [{ id: "a", cell_type: "code" }, { id: "b", cell_type: "markdown" }, { id: "c", cell_type: "code" }, { id: "d", cell_type: "code" }];
const sel = new Map([
  ["a", { cell: "a", state: "captured", full: { sha256: "1".repeat(64), size: 1, rev: 1 } }],
  ["d", { cell: "d", state: "written_after_deadline" }],
  ["z", { cell: "z", state: "captured", full: { sha256: "2".repeat(64), size: 1, rev: 2 } }],
]);
const fd = P.finalDescriptor(census, sel);
check(JSON.stringify(fd.entries.map((e) => [e.cell, e.state])) === JSON.stringify([["a", "captured"], ["b", "not_code"], ["c", "not_run"], ["d", "written_after_deadline"]]), "finalDescriptor: one entry per census cell, with its state");
check(JSON.stringify(fd.dropped) === '["z"]', "finalDescriptor: a selected cell outside the census is dropped");
check(typeof P.outputsDigest(fd.entries) === "string", "finalDescriptor: its entries digest");

// claims
for (const t of V.claims) {
  const b = P.encodeClaims(t.in);
  check(btoa(String.fromCharCode(...b)) === t.out, "claims: encoded");
  check(JSON.stringify(P.decodeClaims(b)) === JSON.stringify(Object.fromEntries(Object.keys(P.decodeClaims(b)).map((k) => [k, t.in[k]]))), "claims: decoded back");
  check(P.checkProgress({ t: "progress", claims: t.out }).claims.length === 32, "progress: accepted");
}
const goodClaims = V.claims[0].in;
throwsCode(() => P.encodeClaims({ ...goodClaims, cells_run: 70000 }), "invalid", "claims: a count over u16");
throwsCode(() => P.encodeClaims({ ...goodClaims, outbox_waiting: -1 }), "invalid", "claims: a negative count");
const raw = P.encodeClaims(goodClaims);
throwsCode(() => P.decodeClaims(raw.slice(0, 31)), "invalid", "claims: 31 bytes");
throwsCode(() => P.decodeClaims(Uint8Array.from(raw, (x, i) => (i === 0 ? 2 : x))), "invalid", "claims: another version");
throwsCode(() => P.decodeClaims(Uint8Array.from(raw, (x, i) => (i === 30 ? 1 : x))), "invalid", "claims: reserved bytes");
throwsCode(() => P.decodeClaims(Uint8Array.from(raw, (x, i) => (i === 1 ? 2 : x))), "invalid", "claims: unknown flags");
throwsCode(() => P.checkProgress({ t: "progress", claims: V.claims[0].out, extra: 1 }), "invalid", "progress: an unknown field");
throwsCode(() => P.checkProgress({ t: "progress", claims: "AAAA" }), "invalid", "progress: short claims");

// ---- the messages

const DOC = "0123456789ab", SHA = "f".repeat(64);
// (sync never carries outputs (William, Oct 26; erratum-sync-no-outputs r2): no outputs message, while LTI's grading
// descriptor keeps its outputs digest and its 4 MiB output bound)
check(!("checkOutputs" in P) && !("outputsSet" in P.DOC_LIMITS) && P.DOC_LIMITS.outputBytes === 4 << 20 && typeof P.outputsDigest === "function", "no sync outputs message; LTI's outputs digest and bound kept");
check(P.checkDocClaim({ t: "doc_claim", req: 1, doc: DOC, epoch: 1, client: "c1" }).client === "c1", "doc_claim: accepted");
check(P.checkDocClaim({ t: "doc_claim", req: 1, doc: DOC, epoch: 3, client: "c1" }).epoch === 3, "doc_claim: its epoch kept");
check(P.checkDocClaim({ t: "doc_claim", req: 1, doc: DOC, epoch: 1, client: "c1", owner: SHA }).owner === SHA, "doc_claim: with an owner");
throwsCode(() => P.checkDocClaim({ t: "doc_claim", req: 1, doc: DOC, epoch: 1, client: "c 1" }), "invalid", "doc_claim: a bad client");
throwsCode(() => P.checkDocClaim({ t: "doc_claim", req: 1, doc: "nope", epoch: 1, client: "c1" }), "invalid", "doc_claim: a bad doc");
throwsCode(() => P.checkDocClaim({ t: "doc_claim", req: 1, doc: DOC, epoch: 1, client: "c1", fgen: 0 }), "invalid", "doc_claim: an unknown field");
throwsCode(() => P.checkDocClaim({ t: "doc_claim", req: 1, doc: DOC, epoch: 1, client: "c1", owner: "x" }), "invalid", "doc_claim: a bad owner");
// (the epoch is required, a whole number from 1)
throwsCode(() => P.checkDocClaim({ t: "doc_claim", req: 1, doc: DOC, client: "c1" }), "invalid", "doc_claim: no epoch");
for (const e of [0, -1, 1.5, "1", null, 2 ** 53]) throwsCode(() => P.checkDocClaim({ t: "doc_claim", req: 1, doc: DOC, epoch: e, client: "c1" }), "invalid", `doc_claim: epoch ${String(e)}`);
const fence = { t: "doc_fence", req: 2, doc: DOC, epoch: 1, clients: [{ client: "c1", target: 3 }] };
check(P.checkDocFence(fence).clients[0].target === 3 && P.checkDocFence(fence).epoch === 1, "doc_fence: accepted, its epoch kept");
throwsCode(() => P.checkDocFence({ t: "doc_fence", req: 2, doc: DOC, clients: [{ client: "c1", target: 3 }] }), "invalid", "doc_fence: no epoch");
for (const e of [0, -1, 1.5, "1", null]) throwsCode(() => P.checkDocFence({ ...fence, epoch: e }), "invalid", `doc_fence: epoch ${String(e)}`);
throwsCode(() => P.checkDocFence({ ...fence, clients: [] }), "invalid", "doc_fence: no clients");
throwsCode(() => P.checkDocFence({ ...fence, clients: Array.from({ length: 9 }, (_, i) => ({ client: "c" + i, target: 1 })) }), "limit", "doc_fence: nine clients");
throwsCode(() => P.checkDocFence({ ...fence, clients: [{ client: "c1", target: 1 }, { client: "c1", target: 2 }] }), "invalid", "doc_fence: a client twice");
throwsCode(() => P.checkDocFence({ ...fence, clients: [{ client: "c1", target: 0 }] }), "invalid", "doc_fence: target 0");
throwsCode(() => P.checkDocFence({ ...fence, clients: [{ client: "c1", target: 2 ** 32 }] }), "invalid", "doc_fence: target past u32");
throwsCode(() => P.checkDocFence({ ...fence, clients: [{ client: "c1", target: 1, x: 1 }] }), "invalid", "doc_fence: an unknown client field");
const inBatch = new Set(["c1", "c2"]);
check(P.checkFgen({ c1: 0, c2: 4 }, inBatch).get("c2") === 4, "fgen: one per client");
throwsCode(() => P.checkFgen({ c1: 0 }, inBatch), "invalid", "fgen: a client missing");
throwsCode(() => P.checkFgen({ c1: 0, c2: 1, c3: 2 }, inBatch), "invalid", "fgen: a client not in the batch");
throwsCode(() => P.checkFgen({ c1: -1, c2: 1 }, inBatch), "invalid", "fgen: a negative generation");
check(P.checkUpto({}, 5) === undefined && P.checkUpto({ upto: 7 }, 5) === 7, "pull upto: absent or at least after");
throwsCode(() => P.checkUpto({ upto: 4 }, 5), "invalid", "pull upto: below after");
const snap = { t: "snapshot", req: 3, doc: DOC, at_seq: 10, sha256: SHA, bytes: 100 };
check(P.checkSnapshot(snap).at_seq === 10, "snapshot: accepted");
throwsCode(() => P.checkSnapshot({ ...snap, at_seq: 0 }), "invalid", "snapshot: at_seq 0");
throwsCode(() => P.checkSnapshot({ ...snap, bytes: (32 << 20) + 1 }), "limit", "snapshot: over 32 MiB");
// both socket forms (CORR-PR62-2): the document socket's message names no doc, and is normalized with the attachment's
const OWNER = "a".repeat(64), VIA = { socket: "document", doc: DOC, owner: OWNER };
const rawSnap = { t: "snapshot", req: 3, at_seq: 10, sha256: SHA, bytes: 100 };
const ds = P.checkSnapshot(rawSnap, VIA);
check(ds.doc === DOC && ds.owner === OWNER && ds.at_seq === 10, "snapshot: the document-socket form, normalized with the attachment's doc and owner");
check(P.checkSnapshot(snap).doc === DOC && P.checkSnapshot(snap).owner === undefined, "snapshot: the account-socket form");
throwsCode(() => P.checkSnapshot(rawSnap), "invalid", "snapshot: the account socket needs doc");
throwsCode(() => P.checkSnapshot({ ...rawSnap, doc: "aaaaaaaaaaaa" }, VIA), "invalid", "snapshot: a document socket's message can't name another doc");
throwsCode(() => P.checkSnapshot({ ...rawSnap, owner: "b".repeat(64) }, VIA), "invalid", "snapshot: a document socket's message can't name another owner");
throwsCode(() => P.checkSnapshot(rawSnap, { socket: "document", doc: "bad", owner: OWNER }), "invalid", "snapshot: a malformed attachment");
check(P.checkDocClaim({ t: "doc_claim", req: 1, epoch: 1, client: "c1" }, VIA).doc === DOC, "doc_claim: the document-socket form");
check(P.checkDocFence({ t: "doc_fence", req: 1, epoch: 1, clients: [{ client: "c1", target: 1 }] }, VIA).owner === OWNER, "doc_fence: the document-socket form");
throwsCode(() => P.checkDocClaim({ t: "doc_claim", req: 1, client: "c1" }, VIA), "invalid", "doc_claim: the document-socket form needs its epoch too");
const blob = { format: "sb-sync-snapshot", v: 1, kind: "notebook", epoch: 1, at_seq: 4, time: "0000000000a_c1", value: "" };
check(P.checkSnapshotBlob(blob).at_seq === 4, "snapshot blob: accepted");
throwsCode(() => P.checkSnapshotBlob({ ...blob, v: 2 }), "invalid", "snapshot blob: another version");
throwsCode(() => P.checkSnapshotBlob({ ...blob, extra: 1 }), "invalid", "snapshot blob: an unknown field");

// ---- the bounds, each refused (typed) before the work it bounds (LIMIT-PR62-1..3)

let deep = 0;
for (let i = 0; i < 20000; i++) deep = [deep];
throwsCode(() => P.jcs(deep), "invalid_value", "jcs: 20,000-deep nesting is a typed refusal, not a RangeError");
const nest = (n) => { let v = 0; for (let i = 0; i < n; i++) v = [v]; return v; };
check(P.jcs(nest(64)).length === 129, "jcs: 64 levels of nesting");
throwsCode(() => P.jcs(nest(65)), "invalid_value", "jcs: 65 levels of nesting");
throwsCode(() => P.jcs({ a: "x".repeat(100) }, 50), "limit", "jcs: over its byte budget");
check(P.jcs({ a: "x".repeat(40) }, 50).length === 48, "jcs: within its byte budget");
const run = { type: "run", id: "s:1", sid: "s", n: 1 };
throwsCode(() => P.sealedValueBytes("notebook", new Array(1_000_001).fill(run)), "limit", "sealed: 1,000,001 source records, before projection");
check(P.utf8(new TextDecoder().decode(P.sealedValueBytes("notebook", new Array(1_000_000).fill(run)))).length === 17, "sealed: 1,000,000 journal records project to the header");
throwsCode(() => P.sealedValueBytes("notebook", [{ type: "cell", id: "x", pos: 0, input: "x".repeat((16 << 20) + 1), cell_type: "code" }]), "limit", "sealed: one retained string over 16 MiB");
throwsCode(() => P.sealedValueBytes("notebook", [{ type: "cell", id: "x", pos: 0, input: nest(70), cell_type: "code" }]), "invalid_value", "sealed: a deeply nested record");
const cellRecs = Array.from({ length: 2001 }, (_, i) => ({ type: "cell", id: "c" + String(i).padStart(5, "0"), pos: i, input: "", cell_type: "code" }));
throwsCode(() => P.censusOf("notebook", cellRecs), "invalid_value", "census: the 2,001st cell, while gathering");
check(P.censusOf("notebook", cellRecs.slice(0, 2000)).length === 2000, "census: 2,000 cells");
throwsCode(() => P.censusOf("notebook", new Array(1_000_001).fill(run)), "limit", "census: 1,000,001 source records");
throwsCode(() => P.censusBytes([{ id: "x".repeat(129), cell_type: "code" }]), "invalid_value", "census: a 129-character id");
check(P.censusBytes([{ id: "x".repeat(128), cell_type: "code" }]).length > 0, "census: a 128-character id");
throwsCode(() => P.censusBytes([{ id: "a", cell_type: "widget" }]), "invalid_value", "census: an unknown cell type");
const big = Array.from({ length: 2001 }, (_, i) => ({ id: "c" + String(i).padStart(5, "0"), cell_type: "code" }));
throwsCode(() => P.finalDescriptor(big, new Map()), "invalid_value", "finalDescriptor: a 2,001-cell census");
throwsCode(() => P.finalDescriptor([], new Map(big.map((c) => [c.id, { cell: c.id, state: "written_after_deadline" }]))), "invalid", "finalDescriptor: a 2,001-cell selection");
check(P.finalDescriptor(big.slice(0, 2000), new Map()).entries.length === 2000, "finalDescriptor: 2,000 cells");
throwsCode(() => P.outputsDigest(big.map((c) => ({ cell: c.id, state: "not_run" }))), "invalid", "digest: 2,001 entries");
check(typeof P.outputsDigest(big.slice(0, 2000).map((c) => ({ cell: c.id, state: "not_run" }))) === "string", "digest: 2,000 entries");
throwsCode(() => P.outputsDigest([{ cell: "x".repeat(129), state: "not_run" }]), "invalid", "digest: a 129-character cell");
throwsCode(() => P.outputsDigest([{ cell: "a", state: "captured", full: { sha256: SHA, size: (4 << 20) + 1, rev: 1 } }]), "limit", "digest: a full output over 4 MiB");
throwsCode(() => P.outputsDigest([{ cell: "a", state: "captured", preview: { sha256: SHA, size: (256 << 10) + 1, rev: 1, kind: "png" } }]), "limit", "digest: a preview over 256 KiB");
// the chain: page and epoch ceilings before any hashing; pages continue from a state
const pv = (bs, extra = {}) => P.verifyChainPage({ epoch: 1, ...extra }, P.chainStart(cs.owner_hash, cs.doc, 1), bs);
const p1 = pv(batches.slice(0, 2));
check(p1.ok && P.verifyChainPage({ epoch: 1 }, p1.state, batches.slice(2)).ok, "verifyChainPage: two pages continue from the state");
check(!P.verifyChainPage({ epoch: 1 }, p1.state, batches.slice(0, 1)).ok, "verifyChainPage: a page that doesn't follow its state");
// a cleared document's epoch starts mid-sequence: chainStartAt(…, root.seq), never seq 0 or a renumbered root
{
  const e = V.chain_epoch2;
  const bs = e.batches.map((b) => ({ ...b, body: P.fromHex(b.body_hex) }));
  const start = P.chainStartAt(e.owner_hash, e.doc, e.epoch, e.first_seq);
  check(start.seq === e.first_seq - 1 && P.hex(start.chain) === e.seed, "chainStartAt: the epoch's seed, at root.seq - 1");
  check(JSON.stringify(P.chainStartAt(e.owner_hash, e.doc, 1, 1)) === JSON.stringify(P.chainStart(e.owner_hash, e.doc, 1)), "chainStartAt(…, 1) is chainStart");
  const r = P.verifyChainPage({ epoch: 2 }, start, bs);
  check(r.ok && P.hex(r.state.chain) === bs[bs.length - 1].chain && r.state.seq === 6, "verifyChainPage: a mid-sequence epoch verifies from chainStartAt");
  const from0 = P.verifyChainPage({ epoch: 2 }, P.chainStart(e.owner_hash, e.doc, 2), bs);
  check(!from0.ok && from0.why === "a gap or a reordering", "verifyChainPage: the default start (seq 0) refuses a mid-sequence epoch");
  const renum = P.verifyChainPage({ epoch: 2 }, P.chainStart(e.owner_hash, e.doc, 2), bs.map((b, i) => ({ ...b, seq: i + 1 })));
  check(!renum.ok && renum.why === "the chain differs", "verifyChainPage: a renumbered root doesn't verify (the chain hashes the stored seq)");
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) throwsCode(() => P.chainStartAt(e.owner_hash, e.doc, 2, bad), "invalid", `chainStartAt refuses first seq ${bad}`);
}
const MiB = new Uint8Array(1 << 20), fake = (seq, body = new Uint8Array(0)) => ({ seq, recv: 1, epoch: 1, author: "a", writer: "w", envs: "[]", body, chain: "" });
throwsCode(() => pv([fake(1, new Uint8Array((1 << 20) + 1))]), "limit", "verifyChainPage: a body over 1 MiB");
throwsCode(() => pv([{ ...fake(1), envs: "x".repeat((1 << 20) + 1) }]), "limit", "verifyChainPage: envelopes over 1 MiB");
throwsCode(() => pv(Array.from({ length: 501 }, (_, i) => fake(i + 1))), "limit", "verifyChainPage: 501 batches");
throwsCode(() => pv(Array.from({ length: 5 }, (_, i) => fake(i + 1, MiB))), "limit", "verifyChainPage: over 4 MiB");
throwsCode(() => P.verifyChain({ ownerHash: cs.owner_hash, doc: cs.doc, epoch: 1, upto: 50_001, expect: last }, []), "limit", "verifyChain: upto past 50,000");
throwsCode(() => P.verifyChain({ ownerHash: cs.owner_hash, doc: cs.doc, epoch: 1, upto: 33, expect: last }, Array.from({ length: 33 }, (_, i) => fake(i + 1, MiB))), "limit", "verifyChain: over 32 MiB of history");
// snapshot blobs: 32 MiB before parsing
throwsCode(() => P.parseSnapshotBlob(new Uint8Array((32 << 20) + 1)), "limit", "parseSnapshotBlob: over 32 MiB, before parsing");
check(P.parseSnapshotBlob(P.utf8(JSON.stringify(blob))).at_seq === 4, "parseSnapshotBlob: a blob within the limit");
throwsCode(() => P.parseSnapshotBlob(P.utf8("{not json")), "invalid", "parseSnapshotBlob: not JSON");
throwsCode(() => P.checkSnapshotBlob({ ...blob, value: "x".repeat((32 << 20) + 1) }), "limit", "checkSnapshotBlob: a value over 32 MiB");

// a string's escaped length is charged before its escaped copy exists (LIMIT-PR62-1): 16 MiB of U+0001
// escapes to 96 MiB; it is refused without making it.  In a child process, so its peak RSS is its own.
throwsCode(() => P.jcs("\u0001".repeat(1 << 20), 6 << 20), "limit", "jcs: 1 MiB of U+0001 (6 MiB escaped) over a 6 MiB budget");
check(P.jcs("\u0001".repeat(1000), 6002).length === 6002, "jcs: escaped length exactly at the budget");
throwsCode(() => P.jcs("\u0001".repeat(1000), 6001), "limit", "jcs: escaped length one over the budget");
throwsCode(() => P.jcs("é".repeat(10), 21), "limit", "jcs: two-byte characters counted as two");
// LRE, the lossless record encoding (plan-sync-slice2-client-r4 §1b): the vectors, then through patchflow's own codec
{
  const S = { notebook: P.NOTEBOOK_SCHEMA, board: P.BOARD_SCHEMA };
  const J = JSON.stringify;
  // (a record is a map: decoded values compared with their keys sorted, at every level; arrays keep their order)
  const canon = (x) => J(x, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
  for (const t of V.lre_encode) {
    const e = P.lreEncode(S[t.schema], t.in);
    check(J(e) === J(t.out), `lre encode: ${J(t.in)} -> ${J(e)}`);
    check(canon(P.lreDecode(S[t.schema], t.out)) === canon(t.in), `lre decode of an encoded record: ${J(t.out)}`);
  }
  for (const t of V.lre_decode) check(canon(P.lreDecode(S[t.schema], t.in)) === canon(t.out), `lre decode, a merge's form: ${J(t.in)}`);
  const refused = (f, field, what) => {
    try {
      f();
      check(false, `${what}: not refused`);
    } catch (e) {
      check(e instanceof P.DocError && e.code === "invalid_value" && e.detail?.field === field, `${what}: ${e?.code} ${J(e?.detail)} (wanted invalid_value, field ${J(field)})`);
    }
  };
  for (const t of V.lre_refused_encode) refused(() => P.lreEncode(S[t.schema], t.in), t.field, `lre encode refuses ${J(t.in)}`);
  for (const t of V.lre_refused_decode) {
    refused(() => P.lreDecode(S[t.schema], t.in), t.field, `lre decode refuses ${J(t.in)}`);
    refused(() => P.lreCheckRecord(S[t.schema], t.in), t.field, `lreCheckRecord refuses ${J(t.in)}`);
  }
  // (depth: refused before any recursion past it, as JCS is)
  let deep = 1;
  for (let i = 0; i < P.DOC_LIMITS.jcsDepth + 2; i++) deep = [deep];
  throwsCode(() => P.lreEncode(S.notebook, { type: "cell", id: "c", x: deep }), "limit", "lre encode: too deep");

  // (astra's CORR-175-1: "__proto__", an ordinary JSON key, is kept as an own data property at every level, on the way out
  // and on the way in, and never becomes a prototype; constructor and prototype are the controls)
  {
  try {
    const own = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
    const rec = JSON.parse('{"type":"cell","id":"c","__proto__":{"kept":7},"x":{"__proto__":{"kept":7},"other":2},"constructor":1,"prototype":{"a":null}}');
    const wire = JSON.parse(JSON.stringify(P.lreEncode(S.notebook, rec)));
    const back = P.lreDecode(S.notebook, wire);
    check(own(back, "__proto__") && back.__proto__ !== Object.prototype && own(back.x, "__proto__") && back.x.other === 2, "lre: __proto__ survives encode, the wire and decode, as own keys at the record and nested");
    check(Object.getPrototypeOf(back) === Object.prototype && Object.getPrototypeOf(back.x) === Object.prototype && back.kept === undefined && back.x.kept === undefined, "lre: …and nothing is inherited (no prototype was set)");
    check(canon(back) === canon(rec) && own(back, "constructor") && own(back, "prototype"), "lre: …the record equals the input, constructor and prototype kept as own keys");
    const incoming = JSON.parse('{"type":"cell","id":"c","__proto__":{"inherited":true}}');
    P.lreCheckRecord(S.notebook, incoming);
    const dec = P.lreDecode(S.notebook, incoming);
    check(own(dec, "__proto__") && dec.inherited === undefined && Object.getPrototypeOf(dec) === Object.prototype, "lre: an incoming record's __proto__ key passes the check and decodes as an own key, not a prototype");
    const { createImmerDbCodec } = await import("patchflow");
    const c = createImmerDbCodec(P.NOTEBOOK_SCHEMA);
    const enc = (r) => c.fromString(J(P.lreEncode(S.notebook, r)));
    const viaPatch = P.lreDecode(S.notebook, JSON.parse(c.toString(c.applyPatch(c.fromString(""), c.makePatch(c.fromString(""), enc(rec)))).trim()));
    check(canon(viaPatch) === canon(rec) && own(viaPatch, "__proto__") && own(viaPatch.x, "__proto__"), "lre: …and through the pinned patchflow codec, from nothing");
  } catch (e) {
    check(false, `CORR-175-1 (__proto__): threw: ${e?.message ?? e}`);
  }
  }
  // (daybreak3's LIMIT-2C1-2: a sparse array is no JSON value: refused on the way out and on the way in, never encoded or
  // skipped; a dense array with explicit nulls is lossless through the wire)
  {
  try {
    const refusedSparse = (f, what) => {
      try {
        f();
        check(false, `${what}: not refused`);
      } catch (e) {
        check(e instanceof P.DocError && e.code === "invalid_value" && /sparse/.test(e.message), `${what}: ${e?.code} ${e?.message}`);
      }
    };
    refusedSparse(() => P.lreEncode(S.notebook, { type: "cell", id: "c", x: new Array(1) }), "lre encode refuses new Array(1)");
    refusedSparse(() => P.lreEncode(S.notebook, { type: "cell", id: "c", x: { y: [1, , 2] } }), "lre encode refuses a nested hole");
    refusedSparse(() => P.lreDecode(S.notebook, { type: "cell", id: "c", x: [1, , 2] }), "lre decode refuses a sparse array");
    refusedSparse(() => P.lreCheckRecord(S.notebook, { type: "cell", id: "c", x: [[, 1]] }), "lreCheckRecord refuses a nested sparse array");
    const dense = { type: "cell", id: "c", x: [null, 1, [null]] };
    const back = P.lreDecode(S.notebook, JSON.parse(JSON.stringify(P.lreEncode(S.notebook, dense))));
    check(canon(back) === canon(dense), "lre: a dense array with explicit nulls through encode, the wire and decode: " + J(back));
  } catch (e) {
    check(false, `LIMIT-2C1-2 (sparse arrays): threw: ${e?.message ?? e}`);
  }
  }
  // (daybreak3's LIMIT-2C1-1, the maximum fixtures: a NUL-key-heavy record at the 256 KiB inline patch bound and a
  // sidecar-heavy board at the 1 MiB batch bound.  Each: exact round trips (the wire, and the pinned codec from nothing);
  // its encoded size exactly the predicted expansion of its own JSON; and where it falls against the bounds and F8's
  // charge, measured on the ENCODED record (lreEncodedBytes), which is what every bound and charge counts)
  {
  try {
    const { createImmerDbCodec } = await import("patchflow");
    const KiB = 1024, PATCH = 256 * KiB, BATCH = 1024 * KiB;
    const bytes = (x) => new TextEncoder().encode(J(x)).length;
    const charge = (x) => 2 * J(x).length + 64; // (F8: inert JSON, two bytes a character, plus 64 B of overhead)
    const rows = [];
    // NUL-key-heavy: N keys "\u0000k<i>", each null.  Each entry grows by 6 (the doubled \u0000, escaped on the wire) and 10
    // (null, 4 bytes, becomes {"\u0000":"n"}, 14 bytes): exactly 16 bytes an entry
    const N = 12000, m = {};
    for (let i = 0; i < N; i++) m["\u0000k" + i] = null;
    const heavy = { type: "cell", id: "c", m };
    const hRaw = bytes(heavy), hEnc = P.lreEncodedBytes(S.notebook, heavy);
    check(hEnc - hRaw === 16 * N, `fixture (NUL-key-heavy): the encoded record is exactly 16 bytes an entry larger: ${hEnc} - ${hRaw} = ${hEnc - hRaw}, want ${16 * N}`);
    check(hRaw <= PATCH && hEnc > PATCH, `fixture (NUL-key-heavy): its own JSON fits the 256 KiB inline bound (${hRaw}) but its encoded record doesn't (${hEnc}): the bound is judged on the encoded bytes`);
    const nb = createImmerDbCodec(P.NOTEBOOK_SCHEMA);
    const hPatch = nb.applyPatch(nb.fromString(""), nb.makePatch(nb.fromString(""), nb.fromString(J(P.lreEncode(S.notebook, heavy)))));
    check(canon(P.lreDecode(S.notebook, JSON.parse(nb.toString(hPatch).trim()))) === canon(heavy) && canon(P.lreDecode(S.notebook, JSON.parse(J(P.lreEncode(S.notebook, heavy))))) === canon(heavy), "fixture (NUL-key-heavy): exact round trips, the wire and the codec");
    rows.push({ fixture: "NUL-key-heavy record", raw: hRaw, encoded: hEnc, charge: charge(P.lreEncode(S.notebook, heavy)) });
    // sidecar-heavy: K board items, every one of the 6 string columns null.  Each `"f":null` (len f + 7 bytes) becomes
    // `"\u0000n:f":true` (len f + 15): exactly 8 bytes a sidecar, 48 an item
    const K = 9000, items = [];
    for (let i = 0; i < K; i++) items.push({ type: "item", page: "", id: "i" + i, title: null, text: null, code: null, detail: null, label: null, intro: null });
    const sRaw = items.reduce((n, r) => n + bytes(r), 0), sEnc = items.reduce((n, r) => n + P.lreEncodedBytes(S.board, r), 0);
    check(sEnc - sRaw === 48 * K, `fixture (sidecar-heavy): exactly 8 bytes a sidecar: ${sEnc} - ${sRaw} = ${sEnc - sRaw}, want ${48 * K}`);
    check(sRaw <= BATCH && sEnc > BATCH, `fixture (sidecar-heavy): its records fit the 1 MiB batch bound as JSON (${sRaw}) but not encoded (${sEnc}): the bound is judged on the encoded bytes`);
    const bc = createImmerDbCodec(P.BOARD_SCHEMA);
    const lines = (rs) => rs.map((r) => J(P.lreEncode(S.board, r))).join("\n");
    const sDoc = bc.applyPatch(bc.fromString(""), bc.makePatch(bc.fromString(""), bc.fromString(lines(items))));
    const sBack = bc.toString(sDoc).trim().split("\n").map((l) => P.lreDecode(S.board, JSON.parse(l)));
    check(sBack.length === K && canon(sBack.sort((x, y) => (x.id < y.id ? -1 : 1))) === canon(items.slice().sort((x, y) => (x.id < y.id ? -1 : 1))), "fixture (sidecar-heavy): exact round trip through the codec (every item, every null)");
    rows.push({ fixture: "sidecar-heavy board (all items)", raw: sRaw, encoded: sEnc, charge: items.reduce((n, r) => n + charge(P.lreEncode(S.board, r)), 0) });
    console.log("LRE maximum fixtures (bytes; charge = F8's 2 bytes a character + 64):");
    for (const r of rows) console.log(`  ${r.fixture}: JSON ${r.raw}, encoded ${r.encoded} (x${(r.encoded / r.raw).toFixed(3)}), charge ${r.charge}`);
  } catch (e) {
    check(false, `LIMIT-2C1-1 (maximum fixtures): threw: ${e?.message ?? e}`);
  }
  }

  // (the reason it exists: through the pinned patchflow codec, a null set, kept, removed and made from nothing survives;
  // raw records lose it.  And board's MUST-1 merges: a field set null on one device while another adds a key)
  const { createImmerDbCodec } = await import("patchflow");
  for (const [kind, schema] of [["notebook", P.NOTEBOOK_SCHEMA], ["board", P.BOARD_SCHEMA]]) {
    const c = createImmerDbCodec(schema);
    const key = kind === "board" ? { type: "item", page: "", id: "i" } : { type: "cell", id: "c" };
    const col = schema.stringCols[0];
    const doc = (rs, enc) => c.fromString(rs.map((r) => J(enc ? P.lreEncode(schema, r) : r)).join("\n"));
    const read = (d) => c.toString(d).trim().split("\n").filter(Boolean).map((l) => P.lreDecode(schema, JSON.parse(l)));
    const via = (a, b) => read(c.applyPatch(doc(a, true), c.makePatch(doc(a, true), doc(b, true))));
    const cases = [
      ["value -> null", [{ ...key, x: 1 }], [{ ...key, x: null }]],
      ["null -> absent", [{ ...key, x: null }], [{ ...key }]],
      ["null -> value", [{ ...key, x: null }], [{ ...key, x: 2 }]],
      ["initially null, from nothing", [], [{ ...key, x: null }]],
      ["a nested null set", [{ ...key, m: { p: 1, q: 2 } }], [{ ...key, m: { p: null, q: 2 } }]],
      ["a nested null kept while a sibling changes", [{ ...key, m: { p: null, q: 1 } }], [{ ...key, m: { p: null, q: 3 } }]],
      ["a string column: text -> null", [{ ...key, [col]: "abc" }], [{ ...key, [col]: null }]],
      ["a string column: null -> text", [{ ...key, [col]: null }], [{ ...key, [col]: "abc" }]],
      ["a string column: null from nothing", [], [{ ...key, [col]: null }]],
      ["a string column: an ordinary edit", [{ ...key, [col]: "hello world" }], [{ ...key, [col]: "hello there world" }]],
    ];
    for (const [name, a, b] of cases) check(canon(via(a, b)) === canon(b), `lre through patchflow (${kind}): ${name}: ${J(via(a, b))}`);
    // (raw records, the control: the codec loses the null)
    const raw = (a, b) => c.toString(c.applyPatch(doc(a, false), c.makePatch(doc(a, false), doc(b, false)))).trim();
    check(!raw([{ ...key, x: 1 }], [{ ...key, x: null }]).includes("null"), `the control (${kind}): raw records lose value -> null`);
    // (MUST-1: device A sets x null, device B adds x.q; both orders decode to the same value, and none is refused)
    const base = doc([{ ...key, x: { p: 1 } }], true);
    const pa = c.makePatch(base, doc([{ ...key, x: null }], true)), pb = c.makePatch(base, doc([{ ...key, x: { p: 1, q: 2 } }], true));
    const ab = read(c.applyPatch(c.applyPatch(base, pa), pb)), ba = read(c.applyPatch(c.applyPatch(base, pb), pa));
    check(canon(ab) === canon(ba), `lre through patchflow (${kind}): a concurrent null and added key converge: ${J(ab)} / ${J(ba)}`);
  }
}

console.log(`${checks - fails.length}/${checks} checks passed`);
if (fails.length) {
  for (const f of fails.slice(0, 40)) console.log("FAIL", f);
  process.exit(1);
}
