// ci: web-runner order=118 runner=bun
// A board's code by capability (web/board/capability.ts, approvals.ts; Codex S14 F1, William's ruling of Nov 28):
//   - the digest of what runs: every executable field of every kind changes it, layout and metadata don't, and a kind
//     or a field it doesn't know makes the board unapprovable (D2);
//   - the approvals: kept only as this code writes them, bounded, forgotten one by one or all, and approving nothing
//     when storage can't be read (D5, D6); merged three ways with a removal winning;
//   - the gate where code crosses: an unconfined worker given code only while it may run (D1, D3);
//   - a board whose run was stopped opens paused (N1).
//   bun web/board/test-capability.mjs
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 300) : "")); if (!c) failures++; };
const J = JSON.stringify;
const mem = new Map();
let broken = false;
globalThis.localStorage = {
  getItem: (k) => { if (broken) throw new Error("storage unavailable"); return mem.has(k) ? mem.get(k) : null; },
  setItem: (k, v) => { if (broken) throw new Error("storage unavailable"); mem.set(k, String(v)); },
  removeItem: (k) => mem.delete(k),
};
const cap = await import("./capability.ts");
const { codeDigest, runnableOf, KINDS, approve, approved, mayRun, allowOnce, forget, forgetAll, validApprovals, mergeApprovals, APPROVALS_MAX, gateWorker, NOT_APPROVED, markStopped, wasStopped, clearStopped, SEED } = cap;
const { BOARD_SEED } = await import("./code.ts");
const { cleanDoc } = await import("./doc.ts");

ok(SEED === BOARD_SEED, "the digest's default seed is code.ts's BOARD_SEED");

// ---- the digest (D2)
{
  const doc = (nodes, extra = {}) => cleanDoc({ ...extra, nodes });
  const base = [{ id: "a", text: "x", code: "1+1", x: 0, y: 0 }, { id: "q", kind: "ask", input: "number", text: "?", check: "answer == 2", hints: ["try", { code: "'h'" }], x: 0, y: 100 }];
  const d0 = doc(base), cells0 = [{ id: "a", code: "1+1", mode: "python" }];
  const h0 = await codeDigest(cells0, d0, "python", SEED);
  ok(/^[0-9a-f]{64}$/.test(h0), "a digest of the code that runs", h0);
  ok(h0 === await codeDigest(cells0, d0, "python", SEED), "the same code, the same digest");
  // (each executable thing changes it)
  const runs = [
    ["a cell's code", [{ id: "a", code: "1+2", mode: "python" }], d0, "python", SEED],
    ["a cell's language", [{ id: "a", code: "1+1", mode: "sage" }], d0, "python", SEED],
    ["a cell's id", [{ id: "b", code: "1+1", mode: "python" }], d0, "python", SEED],
    ["the board's language", cells0, d0, "sage", SEED],
    ["the board's seed", cells0, d0, "python", "1".repeat(64)],
    ["the engine it asks for (\"latest\")", cells0, doc(base, { engine: "latest" }), "python", SEED],
    ["an ask's check", cells0, doc([base[0], { ...base[1], check: "answer == 3" }]), "python", SEED],
    ["an ask's time limit", cells0, doc([base[0], { ...base[1], checkMs: 500 }]), "python", SEED],
    ["an ask's computed hint", cells0, doc([base[0], { ...base[1], hints: ["try", { code: "'other'" }] }]), "python", SEED],
    ["a cell added", [...cells0, { id: "b", code: "2", mode: "python" }], d0, "python", SEED],
  ];
  for (const [what, cells, d, mode, seed] of runs) { const h = await codeDigest(cells, d, mode, seed); ok(h && h !== h0, `changing ${what} changes the digest`); }
  // (text moved between fields doesn't collide)
  const ha = await codeDigest([{ id: "a", code: "bc", mode: "python" }], d0, "python", SEED), hb = await codeDigest([{ id: "ab", code: "c", mode: "python" }], d0, "python", SEED);
  ok(ha !== hb, "no two boards collide by moving text between fields (id \"a\" + code \"bc\" vs id \"ab\" + code \"c\")");
  // (layout and metadata don't)
  const shown = doc([{ ...base[0], text: "other words", title: "T", x: 300, y: 40, color: "#ff0000" }, { ...base[1], text: "other ?", title: "Q", answer: 2, note: "n", x: 9 }], { title: "a title" });
  ok(await codeDigest([{ ...cells0[0], preview: { at: "2026-01-01T00:00:00Z", ms: 1, total: 1, outputs: [] } }], shown, "python", SEED) === h0, "text, titles, places, colours, answers and a cell's preview don't change it");
  // (fail closed: what isn't known)
  ok((await codeDigest([{ id: "a", code: "1", mode: "python", src: "x" }], d0, "python", SEED)) === null, "a cell with a field not known: unapprovable");
  ok(runnableOf({ format: "sagebrush-board", version: 1, nodes: [{ id: "z", kind: "script", code: "x" }] }) === null && (await codeDigest(cells0, { nodes: [{ id: "z", kind: "script", code: "x" }] }, "python", SEED)) === null, "an item kind not known (with a code field): unapprovable, held unconfined");
  ok((await codeDigest(cells0, { nodes: [{ id: "a", code: "1", run: "x" }] }, "python", SEED)) === null, "a known kind with a field not known: unapprovable");
  ok((await codeDigest(cells0, d0, "cobol", SEED)) === null, "a language not known: unapprovable");
  // (the table is cleanDoc's: every field it keeps, of every kind, is in KINDS)
  const maximal = cleanDoc({ nodes: [
    { id: "n", title: "t", text: "x", code: "1", hideCode: true, mode: "sage", detail: "d", ref: "r", color: "#ff0000", shape: "round", fit: true, x: 1, y: 2, w: 30, h: 40 },
    { id: "g", kind: "group", title: "t", text: "x", layout: "row", columns: 2, direction: "down", children: [{ id: "k", text: "c" }], color: "#00ff00", x: 1, y: 1, w: 200, h: 200 },
    { id: "i", kind: "ink", x: 1, y: 2, points: [0, 0, 1, 5, 5, 1], size: 3, color: "#000000", opacity: 0.5 },
    { id: "s", kind: "sticker", emoji: "🙂", color: "#000000", x: 1, y: 1, w: 20 },
    { id: "a", kind: "ask", title: "q", text: "?", input: "number", required: true, min: 0, max: 9, step: 1, low: "l", high: "h", lines: 2, answer: 3, note: "n", check: "answer==3", checkMs: 100, hints: ["h", { code: "'x'" }], next: { right: "n", wrong: "n" }, decide: [{ name: "m", about: "a", next: "n" }], example: 1, attempts: 1, wrongAttempts: 0, result: "right", detail: "d", color: "#000000", x: 1, y: 1, w: 9, h: 9 },
  ] });
  const unknown = maximal.nodes.flatMap((n) => Object.keys(n).filter((f) => !KINDS[n.kind ?? "note"]?.run.includes(f) && !KINDS[n.kind ?? "note"]?.shown.includes(f)).map((f) => `${n.kind ?? "note"}.${f}`));
  ok(unknown.length === 0 && runnableOf(maximal) !== null, "every field cleanDoc keeps, of every kind, is in the digest's table (run or shown)", unknown);
}

// ---- the approvals (D5, D6)
{
  const H = (c) => c.repeat(64);
  mem.clear();
  ok(!approved(H("a")) && !mayRun(H("a")) && !mayRun(null), "nothing approved at first; no digest is never approved");
  ok(approve(H("a"), undefined, 100) && approved(H("a")) && mayRun(H("a")), "approved, kept in the permissions record");
  const rec = JSON.parse(mem.get("sagebrush-grants"));
  ok(rec.v === 1 && J(rec.approvals) === J({ [`host:${H("a")}`]: 100 }) && J(rec.docs) === "{}", "…as `approvals`, \"host:\" and the digest, and its time", rec);
  // (the rest of the record as it is)
  mem.set("sagebrush-grants", J({ ...rec, docs: { d1: { write: ["/x"], t: 3 } }, seq: 4, seenFile: "t" }));
  approve(H("b"), undefined, 200);
  const rec2 = JSON.parse(mem.get("sagebrush-grants"));
  ok(J(rec2.docs) === J({ d1: { write: ["/x"], t: 3 } }) && rec2.seq === 4 && rec2.seenFile === "t" && Object.keys(rec2.approvals).length === 2, "approving keeps the rest of the record (grants, counter, grants.json's base)");
  ok(forget(H("a")) && !approved(H("a")) && approved(H("b")), "forgotten one by one");
  ok(forgetAll() && !approved(H("b")) && JSON.parse(mem.get("sagebrush-grants")).approvals === undefined, "…or all");
  // (malformed: approves nothing)
  for (const [what, a] of [["a key that isn't host: and a digest", { [`files:${H("c")}`]: 1 }], ["a short digest", { "host:abc": 1 }], ["a time that isn't an integer", { [`host:${H("c")}`]: "1" }], ["an array", [1]], ["a string", "host"]]) {
    mem.set("sagebrush-grants", J({ v: 1, docs: {}, approvals: a }));
    ok(!approved(H("c")) && J(validApprovals(a)) === "{}", `malformed (${what}): approves nothing`);
  }
  mem.set("sagebrush-grants", J({ v: 2, docs: {}, approvals: { [`host:${H("c")}`]: 1 } }));
  ok(!approved(H("c")) && !approve(H("d")), "a record of another version: approves nothing, and isn't written over");
  mem.clear();
  approve(H("e"));
  broken = true;
  ok(!approved(H("e")) && !mayRun(H("e")) && !approve(H("f")), "storage that can't be read: nothing approved, nothing written");
  broken = false;
  // (bounded: the newest kept)
  const many = Object.fromEntries(Array.from({ length: APPROVALS_MAX + 5 }, (_, i) => [`host:${i.toString(16).padStart(64, "0")}`, i]));
  const kept = validApprovals(many);
  ok(Object.keys(kept).length === APPROVALS_MAX && !(`host:${"0".repeat(64)}` in kept) && `host:${(APPROVALS_MAX + 4).toString(16).padStart(64, "0")}` in kept, `at most ${APPROVALS_MAX}, the least recently made or used going first`);
  // (this page only, when an approval can't be kept)
  allowOnce(H("9"));
  ok(mayRun(H("9")) && !approved(H("9")), "run once in this page (an approval that couldn't be kept): may run here, not approved");
  forget(H("9"));
  ok(!mayRun(H("9")), "…and forgetting it ends that too");
  // (merged three ways: a removal wins, one made by either comes in)
  const A = (k) => `host:${H(k)}`;
  const m = mergeApprovals({ [A("1")]: 1, [A("2")]: 1 }, { [A("1")]: 1, [A("3")]: 5 }, { [A("2")]: 2, [A("1")]: 3, [A("4")]: 4 });
  ok(J(Object.keys(m).sort()) === J([A("1"), A("3"), A("4")].sort()) && m[A("1")] === 3, "merged: one removed by either side gone (2), one made by either in (3, 4), the later time", m);
}

// ---- the gate where code crosses (D1, D3)
{
  const sent = [];
  const fake = { postMessage: (m) => sent.push(m), terminate() {}, onmessage: null, onerror: null };
  let confined = false, allowed = false;
  const g = gateWorker(fake, () => confined, () => allowed);
  const heard = [];
  g.onmessage = (e) => heard.push(e.data);
  g.postMessage({ init: { limits: {} } });
  g.postMessage({ files: [] });
  g.postMessage({ id: 1, code: "import os" });
  g.postMessage({ id: 2, interact: { x: 1 } });
  g.postMessage({ id: 3, complete: "os." });
  await new Promise((r) => setTimeout(r, 0));
  ok(J(sent.map((m) => Object.keys(m)[0])) === J(["init", "files"]), "unconfined and not approved: its start and files go through, no code", sent);
  ok(heard.some((d) => d.id === 1 && d.text === NOT_APPROVED) && heard.some((d) => d.id === 1 && d.done && d.error) && heard.some((d) => d.id === 2 && d.done) && heard.some((d) => d.id === 3 && d.skipped), "…a run and an interaction answered as not run, saying why; a question skipped", heard);
  allowed = true;
  g.postMessage({ id: 4, code: "1" });
  confined = true; allowed = false;
  g.postMessage({ id: 5, code: "2" });
  ok(sent.some((m) => m.id === 4) && sent.some((m) => m.id === 5), "approved, or confined: code goes through");
  confined = false;
  g.postMessage({ id: 6, code: "3" });
  ok(!sent.some((m) => m.id === 6), "approval forgotten (or the runner given up for a plain worker): the next code is refused at once");
  fake.onmessage({ data: { id: 4, done: true } });
  ok(heard.some((d) => d.id === 4 && d.done) && g.raw === fake, "what the worker says reaches the kernel; the worker itself is there for the pill");
}

// ---- N1: a board whose run was stopped opens paused
{
  mem.clear();
  ok(!wasStopped("r1"), "not stopped");
  markStopped("r1");
  ok(wasStopped("r1") && !wasStopped("r2"), "stopped: it opens paused (this board only)");
  clearStopped("r1");
  ok(!wasStopped("r1"), "run again: no longer");
  for (let i = 0; i < 250; i++) markStopped("b" + i);
  ok(JSON.parse(mem.get("sagebrush-board-stopped")).length === 200 && wasStopped("b249") && !wasStopped("b0"), "the stopped marks bounded (the 200 latest)");
}

// ---- a sandboxed frame, where merely reading localStorage throws: nothing approved, nothing marked, nothing thrown
{
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("SecurityError: The document is sandboxed"); } });
  let threw = null;
  let r;
  try { r = [approved("a".repeat(64)), mayRun("a".repeat(64)), approve("a".repeat(64)), forget("a".repeat(64)), forgetAll(), wasStopped("r")]; markStopped("r"); clearStopped("r"); } catch (e) { threw = String(e); }
  Object.defineProperty(globalThis, "localStorage", real);
  ok(threw === null && J(r) === J([false, false, false, false, false, false]), "a page whose localStorage can't even be read (a sandboxed frame): nothing approved, nothing marked, nothing thrown", { threw, r });
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
