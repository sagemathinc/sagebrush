// The comments core (comments-core.mjs; plan latex-comments r4.2): the merge, the anchors, the limits, the retries.
// Named after the reviews' implementation tests (astra LC-T1..T7, daybreak3 DB3-IMPL-1..4).
//   bun web/latex/test-comments-core.mjs
import * as C from "./comments-core.mjs";

const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 600)); };
const throws = (f) => { try { f(); return null; } catch (e) { return e; } };
const H = { author: "person:wstein" }, A = { author: "agent:claude" };
const canon = (d) => JSON.stringify({ ...d, threads: [...d.threads].sort((p, q) => (p.id < q.id ? -1 : 1)) });

const TEX = "\\documentclass{article}\n\\begin{document}\nLet $n$ be even. Then $n^2$ is even.\n\nThe sum of two odd numbers is even.\n\\end{document}\n";
const at = (s) => [TEX.indexOf(s), TEX.indexOf(s) + s.length];

// ---- LC-T1: registers converge, reopen sticks, a stale snapshot can't resurrect
{
  let d = C.emptyDoc({ fid: "f1", path: "/p.tex" });
  const [s, e] = at("Then $n^2$ is even.");
  ({ doc: d } = C.addThread(d, { anchor: C.makeAnchor(TEX, s, e), text: "Why?", ...H }));
  const id = d.threads[0].id, base = d;
  const r1 = C.setResolved(base, id, true, A).doc;                 // the agent resolves
  const r2 = C.setResolved(r1, id, false, H).doc;                  // the person reopens (rev 2)
  const stale = C.setResolved(base, id, true, { author: "agent:other" }).doc; // a stale snapshot resolves (rev 1)
  const m1 = C.merge(r2, stale), m2 = C.merge(stale, r2);
  check("LC-T1-reopen-wins-over-stale-resolve", m1.threads[0].resolved.value === false && canon(m1) === canon(m2), m1.threads[0].resolved);
  // two distinct writes with the same rev, time and author: the op decides, the same on both sides
  const t = "2026-10-29T20:00:00.000Z";
  const x = C.setResolved(base, id, true, { author: "agent:a", time: t }).doc, y = C.setResolved(base, id, false, { author: "agent:a", time: t }).doc;
  check("LC-T1-op-tiebreak-converges", canon(C.merge(x, y)) === canon(C.merge(y, x)));
  // replies from two sides: both kept
  const ra = C.reply(base, id, { text: "from A", ...A }).doc, rb = C.reply(base, id, { text: "from H", ...H }).doc;
  const rm = C.merge(ra, rb);
  check("LC-T1-concurrent-replies-both-kept", rm.threads[0].messages.length === 3 && canon(rm) === canon(C.merge(rb, ra)));
  // a deletion is a tombstone: its texts cleared; a stale copy with the text can't bring it back
  const del = C.deleteThread(rb, id, H).doc, back = C.merge(rb, del);
  check("LC-T4-tombstone-survives-stale-copy", back.threads[0].deleted.value === true && back.threads[0].messages.every((m) => m.text.value === "") && canon(back) === canon(C.merge(del, rb)));
}

// ---- LC-T3: anchors: every status; a duplicated quote never silently attached
{
  const R = (text) => C.resolver(text);
  const [s, e] = at("The sum of two odd numbers is even.");
  const a = C.makeAnchor(TEX, s, e);
  check("LC-T3-exact", R(TEX).resolve(a).status === "exact");
  const moved = "Intro.\n\n" + TEX;
  const rm = R(moved).resolve(a);
  check("LC-T3-moved", rm.status === "moved" && moved.slice(rm.start, rm.end) === "The sum of two odd numbers is even.", rm);
  // after an agent's edit the sentence occurs twice: different contexts pick the one whose context matches
  // (the copy placed elsewhere, so the original keeps its prefix and suffix: r4 §8.4's "one occurrence whose context
  //  still matches"; a copy right beside it would change its context, and that is the ambiguous case below)
  const twiceDiff = TEX.replace("\\begin{document}\n", "\\begin{document}\nRecall: The sum of two odd numbers is even. Indeed.\n");
  const rd = R(twiceDiff).resolve(a);
  check("LC-T3-duplicate-picked-by-context", rd.status === "moved" && rd.start === twiceDiff.lastIndexOf("The sum of two odd"), rd);
  // the same with the same contexts: ambiguous, attached to neither
  const block = "\n\nThe sum of two odd numbers is even.\n\\end";
  const twiceSame = TEX.replace("\n\nThe sum of two odd numbers is even.\n\\end", block.replace("\\end", "") + "XX" + block).replace("XX", "");
  const ra = R(twiceSame).resolve({ ...a, textSha: "x", prefix: "\n\n", suffix: "\n" });
  check("LC-T3-duplicate-same-context-ambiguous", ra.status === "ambiguous" && ra.candidates.length === 2, ra);
  // the agent rewrote the sentence: the text between prefix and suffix (changed)
  const rewritten = TEX.replace("The sum of two odd numbers is even.", "Adding two odd numbers gives an even number.");
  const rc = R(rewritten).resolve(a);
  check("LC-T3-changed", rc.status === "changed" && rewritten.slice(rc.start, rc.end) === "Adding two odd numbers gives an even number.", rc);
  // gone with its context: orphaned
  check("LC-T3-orphaned", R("\\documentclass{article}\nnothing\n").resolve(a).status === "orphaned");
  // two prefix/suffix pairs fit: ambiguous
  const pre = a.prefix, suf = a.suffix, two = pre + "AAA" + suf + "\n" + pre + "BBB" + suf;
  check("LC-T3-changed-two-pairs-ambiguous", R(two).resolve({ ...a, textSha: "x", quote: "zzz" }).status === "ambiguous");
  // a long span: recovered whole (head, tail, length, sha), never truncated; a changed middle is not a match
  const long = "x".repeat(50) + "BEGIN" + "y".repeat(900) + "END" + "z".repeat(50);
  const la = C.makeAnchor(long, 50, 50 + 908);
  check("LC-T3-long-anchor-shape", la.quote.length === 300 && la.tail.length === 300 && la.length === 908 && typeof la.sha === "string");
  const lm = R("prefix " + long).resolve(la);
  check("LC-T3-long-span-recovered-whole", lm.status === "moved" && lm.end - lm.start === 908, lm);
  const lmid = R("prefix " + long.replace("y".repeat(900), "y".repeat(400) + "Q" + "y".repeat(499))).resolve(la);
  check("LC-T3-long-span-changed-middle-not-moved", lmid.status !== "moved", lmid);
}

// ---- DB3-IMPL-3: the work budget, every inspection charged; the adversarial repeated quote
{
  const phrase = "the same words again ", big = phrase.repeat(Math.floor((4 << 20) / phrase.length));
  const R = C.resolver(big);
  const anchors = Array.from({ length: 2000 }, () => ({ start: 0, end: phrase.length, quote: phrase, prefix: "", suffix: "", textSha: "stale" }));
  const t0 = performance.now();
  const st = anchors.map((x) => R.resolve(x).status);
  const ms = performance.now() - t0, counts = st.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});
  check("DB3-IMPL-3-adversarial-bounded", R.work() <= C.LIMITS.workBudget + 4 * big.length && st.every((x) => x === "ambiguous" || x === "unresolved") && ms < 20000, { work: R.work(), ms: Math.round(ms), counts });
  console.log("adversarial:", JSON.stringify({ work: R.work(), budget: C.LIMITS.workBudget, ms: Math.round(ms), counts }));
}

// ---- LC-T4 / DB3-IMPL-1/2: admission at the boundaries; refusal writes nothing
{
  const d = C.emptyDoc({});
  const anc = C.makeAnchor(TEX, 0, 5);
  check("LC-T4-text-at-limit-ok", !throws(() => C.addThread(d, { anchor: anc, text: "x".repeat(C.LIMITS.text), ...H })));
  check("LC-T4-text-over-limit-refused", throws(() => C.addThread(d, { anchor: anc, text: "x".repeat(C.LIMITS.text + 1), ...H }))?.code === "limit");
  check("LC-T4-author-over-limit-refused", throws(() => C.addThread(d, { anchor: anc, text: "a", author: "a".repeat(101) }))?.code === "limit");
  // a thread capped at 256 KiB: replies refused (full) at the cap; show returns it whole
  let t = C.addThread(d, { anchor: anc, text: "x".repeat(8000), ...H }), e = null, n = 1;
  while (!e) { try { t = C.reply(t.doc, t.id, { text: "y".repeat(8000), ...A }); n++; } catch (x) { e = x; } }
  check("DB3-IMPL-1-thread-cap-full", e.code === "full" && n < C.LIMITS.messages && new TextEncoder().encode(JSON.stringify(t.doc.threads[0])).length <= C.LIMITS.threadBytes, { code: e.code, n });
  const sh = C.show(t.doc, TEX, t.id);
  check("DB3-IMPL-1-show-whole-thread", sh.messages.length === n && new TextEncoder().encode(JSON.stringify(sh)).length < C.LIMITS.listBytes);
  // the 1.75 MiB headroom: a new thread refused above it, a reply still accepted
  let big = C.emptyDoc({});
  while (new TextEncoder().encode(JSON.stringify(big, null, 1)).length <= C.LIMITS.newThreadBytes) { const r = C.addThread(big, { anchor: anc, text: "z".repeat(7000), ...H }); big = r.doc; }
  const ne = throws(() => C.addThread(big, { anchor: anc, text: "new", ...H }));
  check("DB3-IMPL-2-new-thread-refused-over-1.75MiB", ne?.code === "full" && ne.detail?.limit === "newThreadBytes", ne?.detail);
  check("DB3-IMPL-2-reply-accepted-over-1.75MiB", !throws(() => C.reply(big, big.threads[0].id, { text: "ok", ...A })));
}

// ---- LC-T2 / DB3-IMPL-4: retries exactly (conflicts only, 5 attempts, re-read each time), the deadline, gone
{
  const store = (init = null) => { let content = init, base = 0, writes = 0; return { get: () => content, writes: () => writes, io: { read: async () => ({ content, base }), write: async (c, b) => { if (b !== base) { const e = new Error("conflict"); e.code = "conflict"; throw e; } content = c; base++; writes++; } } }; };
  const anc = C.makeAnchor(TEX, 0, 5);
  const add = (text, who = H) => (doc) => C.addThread(doc, { anchor: anc, text, ...who });
  const nosleep = { sleep: async () => {} };
  // permanent conflict: 5 attempts, then busy with the draft, nothing written
  let tries = 0;
  const perm = { read: async () => ({ content: null, base: 0 }), write: async () => { tries++; const e = new Error("c"); e.code = "conflict"; throw e; } };
  const pe = await C.update(perm, add("draft text"), { draft: "draft text", ...nosleep }).catch((e) => e);
  check("LC-T2-permanent-conflict-busy-after-5", pe.code === "busy" && tries === 5 && pe.detail?.draft === "draft text", { code: pe.code, tries });
  // a non-conflict error: one attempt, not retried
  let tries2 = 0;
  const bad = { read: async () => ({ content: null, base: 0 }), write: async () => { tries2++; const e = new Error("storage"); e.code = "storage"; throw e; } };
  const be = await C.update(bad, add("x"), nosleep).catch((e) => e);
  check("LC-T2-non-conflict-not-retried", be.code === "storage" && tries2 === 1);
  // two contenders: both comments survive (the loser re-reads and re-applies)
  const S = store();
  let first = true;
  const racing = { read: S.io.read, write: async (c, b) => { if (first) { first = false; await S.io.write(C.serialize(C.addThread(C.emptyDoc({}), { anchor: anc, text: "other writer", ...A }).doc), 0); } return S.io.write(c, b); } };
  const ok = await C.update(racing, add("mine"), nosleep);
  const fin = C.parse(S.get());
  check("LC-T2-two-contenders-both-kept", ok.attempts === 2 && fin.threads.length === 2, { attempts: ok.attempts, n: fin.threads.length });
  // a reply to a thread deleted meanwhile: gone, not retried
  const S2 = store(C.serialize(C.deleteThread(fin, fin.threads[0].id, H).doc));
  const ge = await C.update(S2.io, (doc) => C.reply(doc, fin.threads[0].id, { text: "hi", ...A }), nosleep).catch((e) => e);
  check("LC-T2-reply-to-deleted-gone", ge.code === "gone" && S2.writes() === 0);
  // the deadline: slow I/O stops with busy after fewer than 5 attempts, nothing half-written
  let tries3 = 0;
  const slow = { read: async () => { await new Promise((r) => setTimeout(r, 60)); return { content: null, base: 0 }; }, write: async () => { tries3++; await new Promise((r) => setTimeout(r, 60)); const e = new Error("c"); e.code = "conflict"; throw e; } };
  const de = await C.update(slow, add("late"), { deadlineMs: 300 }).catch((e) => e);
  check("DB3-IMPL-4-deadline-busy-fewer-attempts", de.code === "busy" && tries3 < 5, { code: de.code, tries3 });
}

// ---- DB3-IMPL-1: list summaries, paged by id, stale on change
{
  let d = C.emptyDoc({});
  for (let i = 0; i < 230; i++) d = C.addThread(d, { anchor: C.makeAnchor(TEX, 0, 5), text: "c" + i, ...H }).doc;
  const p1 = C.list(d, TEX);
  const p2 = C.list(d, TEX, { cursor: p1.cursor });
  check("DB3-IMPL-1-list-pages", p1.threads.length === 200 && p1.more && p2.threads.length === 30 && !p2.more && p2.threads[0].id > p1.threads[199].id);
  const changed = C.addThread(d, { anchor: C.makeAnchor(TEX, 0, 5), text: "new", ...H }).doc;
  check("DB3-IMPL-1-list-stale", throws(() => C.list(changed, TEX, { cursor: p1.cursor }))?.code === "stale");
  check("list-agent-flag", C.list(C.reply(d, d.threads[0].id, { text: "done", ...A }).doc, TEX).threads.find((t) => t.id === d.threads[0].id).last.agent === true);
}

// ---- format: version refused, round trip, locateSpan
{
  check("format-version-refused", throws(() => C.parse(JSON.stringify({ ...C.emptyDoc({}), version: 2 })))?.code === "version");
  const d = C.addThread(C.emptyDoc({ fid: "a", path: "/p.tex" }), { anchor: C.makeAnchor(TEX, 0, 5), text: "hi", ...H }).doc;
  check("format-round-trip", canon(C.parse(C.serialize(d))) === canon(d));
  check("locate-ambiguous-quote", throws(() => C.locateSpan(TEX + "even.", { quote: "even." }))?.code === "ambiguous");
  check("locate-occurrence", C.locateSpan(TEX, { quote: "is even.", occurrence: 2 }).start === TEX.lastIndexOf("is even."));
  check("sha256-known", C.sha256("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}

const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length}: ${failed.join(", ")}` : `ok: the comments core, ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
