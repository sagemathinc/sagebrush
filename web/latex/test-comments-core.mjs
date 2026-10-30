// The comments core (comments-core.mjs; plan latex-comments r4.2): the merge, the anchors, the limits, the retries.
// Named after the reviews' implementation tests (astra LC-T1..T7, daybreak3 DB3-IMPL-1..4).
//   bun web/latex/test-comments-core.mjs
import * as C from "./comments-core.mjs";
import { createHash } from "node:crypto";

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
  // the agent deleted the sentence, its context kept: nothing (or only white space) between prefix and suffix is
  // removed text (orphaned), not a rewrite
  const deleted = TEX.replace("The sum of two odd numbers is even.", ""), rx = R(deleted).resolve(a);
  check("LC-T3-deleted-between-context-orphaned", rx.status === "orphaned" && rx.reason === "removed", rx);
  const blanked = TEX.replace("The sum of two odd numbers is even.", "  \n "), rb = R(blanked).resolve(a);
  check("LC-T3-whitespace-between-context-orphaned", rb.status === "orphaned", rb);
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
  // (at the largest source comments take: 2 Mi units; the plan's 4 MiB became 2 MiB with the source limit, PR 316)
  const phrase = "the same words again ", big = phrase.repeat(Math.floor(C.LIMITS.sourceUnits / phrase.length));
  const R = C.resolver(big);
  const anchors = Array.from({ length: 2000 }, () => ({ start: 0, end: phrase.length, quote: phrase, prefix: "", suffix: "", textSha: "stale" }));
  const t0 = performance.now();
  const st = anchors.map((x) => R.resolve(x).status);
  const ms = performance.now() - t0, counts = st.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});
  check("DB3-IMPL-3-adversarial-bounded", R.work() <= C.LIMITS.workBudget && st.every((x) => x === "ambiguous" || x === "unresolved") && ms < 20000, { work: R.work(), ms: Math.round(ms), counts });
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

// ---- LC-T1 / LC-T3 / LC-T4 / LC-T6 / LC-T7: the edge contracts named in the implementation review
{
  const anc = C.makeAnchor(TEX, 0, 5);
  let d = C.addThread(C.emptyDoc({}), { anchor: anc, text: "one", ...H });
  const id = d.id; d = d.doc;
  // LC-T1: merge is idempotent; the same op id with different values (a collision) still merges one way
  const r = C.reply(d, id, { text: "two", ...A }).doc, m = C.merge(d, r);
  check("LC-T1-merge-idempotent", canon(C.merge(m, m)) === canon(m) && canon(C.merge(m, r)) === canon(m));
  const t = "2026-10-29T20:00:00.000Z", same = (v) => { const x = C.setResolved(d, id, v, { author: "agent:a", time: t }).doc; x.threads[0].resolved.op = "o_samesamesamesame"; return x; };
  const cx = same(true), cy = same(false);
  check("LC-T1-op-collision-deterministic", canon(C.merge(cx, cy)) === canon(C.merge(cy, cx)));
  // LC-T1: a register without its op id (no such legacy files exist: version 1 is the first) is refused, not guessed
  const legacy = JSON.parse(C.serialize(d)); delete legacy.threads[0].resolved.op;
  check("LC-T1-register-without-op-refused", throws(() => C.parse(JSON.stringify(legacy)))?.code === "invalid");
  // LC-T4: a concurrent addition survives an unrelated deletion
  const added = C.addThread(d, { anchor: anc, text: "added", ...A }).doc, deleted = C.deleteThread(d, id, H).doc;
  const md = C.merge(added, deleted);
  check("LC-T4-addition-survives-unrelated-deletion", md.threads.length === 2 && md.threads.find((x) => x.id === id).deleted.value === true && md.threads.some((x) => x.messages[0].text.value === "added") && canon(md) === canon(C.merge(deleted, added)));
  // LC-T3: one prefix with two suffixes after it, two prefixes with one suffix, the empty boundary at the file's start,
  // and over 64 candidates: ambiguous (or orphaned when nothing fits), never one picked
  const R = (x) => C.resolver(x);
  const base = { start: 10, end: 13, textSha: "stale", quote: "QQQ" };
  check("LC-T3-one-prefix-two-suffixes-ambiguous", R("PRE-aaa-SUF-bbb-SUF").resolve({ ...base, prefix: "PRE-", suffix: "-SUF" }).status === "ambiguous");
  check("LC-T3-two-prefixes-one-suffix-ambiguous", R("PRE-aaa-PRE-bbb-SUF").resolve({ ...base, prefix: "PRE-", suffix: "-SUF" }).status === "ambiguous");
  const st0 = R("new opening words-SUF and more").resolve({ ...base, start: 0, end: 3, prefix: "", suffix: "-SUF" });
  check("LC-T3-empty-prefix-is-file-start", st0.status === "changed" && st0.start === 0, st0);
  check("LC-T3-empty-prefix-not-file-start-orphaned", R("xx").resolve({ ...base, start: 5, end: 8, prefix: "", suffix: "-SUF" }).status === "orphaned");
  const many = R("QQQ ".repeat(70)).resolve({ ...base, prefix: "<", suffix: ">" });
  check("LC-T3-candidate-overflow-ambiguous", many.status === "ambiguous" && many.reason === "too many", many);
  // LC-T3: UTF-16 offsets: an anchor after astral characters is exact where it was made, and found again (moved)
  const astral = "\u{1D4AA}\u{1F600} then the words", aa = C.makeAnchor(astral, astral.indexOf("the words"), astral.length);
  const ra = R("\u{1F600}" + astral).resolve(aa);
  check("LC-T3-utf16-offsets", R(astral).resolve(aa).status === "exact" && ra.status === "moved" && ("\u{1F600}" + astral).slice(ra.start, ra.end) === "the words", ra);
  // the incremental hash: the same digest in slices (never inside a surrogate pair) as in one call
  const big = ("a\u{1F600}b ").repeat(50000), h = C.sha256Hasher();
  for (let i = 0; i < big.length;) { const j = C.sliceAt(big, i + 4097); h.update(big.slice(i, j)); i = j; }
  check("sha256-sliced-same", h.digest() === C.sha256(big));
}
// LC-T6 / LC-T7: writes at their boundaries
{
  const anc = C.makeAnchor(TEX, 0, 5), nosleep = { sleep: async () => {} };
  const store = (init = null) => { let content = init, base = 0, writes = 0; return { get: () => content, writes: () => writes, io: { read: async () => ({ content, base }), write: async (c, b) => { if (b !== base) { const e = new Error("conflict"); e.code = "conflict"; throw e; } content = c; base++; writes++; } } }; };
  // LC-T6: a write that lands but whose answer is lost (a timeout after it was issued): reconciled as saved, once
  const S = store(); let lost = 0;
  const flaky = { read: S.io.read, write: async (c, b) => { await S.io.write(c, b); if (!lost++) { const e = new Error("timed out"); e.code = "timeout"; throw e; } } };
  const ok = await C.update(flaky, (doc) => C.addThread(doc, { anchor: anc, text: "once", ...H }), nosleep);
  check("LC-T6-uncertain-write-reconciled", ok.reconciled === true && C.parse(S.get()).threads.length === 1 && S.writes() === 1, ok);
  // LC-T6: one that didn't land: the error stands, nothing written
  const S2 = store(); const failing = { read: S2.io.read, write: async () => { const e = new Error("timed out"); e.code = "timeout"; throw e; } };
  const fe = await C.update(failing, (doc) => C.addThread(doc, { anchor: anc, text: "x", ...H }), nosleep).catch((e) => e);
  check("LC-T6-uncertain-write-not-landed", fe.code === "timeout" && S2.get() === null);
  // LC-T4: a refused admission writes nothing (the op throws before any write)
  const S3 = store(C.serialize(C.emptyDoc({})));
  const ae = await C.update(S3.io, (doc) => C.addThread(doc, { anchor: anc, text: "x".repeat(C.LIMITS.text + 1), ...H }), nosleep).catch((e) => e);
  check("LC-T4-refused-admission-writes-nothing", ae.code === "limit" && S3.writes() === 0);
  // LC-T7: the 256 KiB thread bound counts the encoded bytes: escaped quotes take twice the room
  let q = C.addThread(C.emptyDoc({}), { anchor: anc, text: '"'.repeat(8000), ...H }), qe = null, qn = 1;
  while (!qe) { try { q = C.reply(q.doc, q.id, { text: '"'.repeat(8000), ...A }); qn++; } catch (x) { qe = x; } }
  const qb = new TextEncoder().encode(JSON.stringify(q.doc.threads[0])).length;
  check("LC-T7-thread-bound-encoded-bytes", qe.code === "full" && qb <= C.LIMITS.threadBytes && qn < 18, { qn, qb });
  // LC-T7: the new-thread threshold exactly: a file of exactly 1.75 MiB still takes a new thread, one byte over doesn't
  const size = (doc) => new TextEncoder().encode(JSON.stringify(doc, null, 1)).length + 1;
  const T = C.LIMITS.newThreadBytes;
  let b = C.emptyDoc({});
  // (large fillers, then small ones, so the last thread's text lands it exactly: within the 8,000-unit text limit)
  while (size(b) < T - 20000) b = C.addThread(b, { anchor: anc, text: "z".repeat(7900), ...H }).doc;
  while (size(b) + 4000 < T) b = C.addThread(b, { anchor: anc, text: "z".repeat(1000), ...H }).doc;
  const probe = C.addThread(b, { anchor: anc, text: "", ...H }).doc, k = T - size(probe);
  const atT = C.addThread(b, { anchor: anc, text: "z".repeat(k), ...H }).doc, overT = C.addThread(b, { anchor: anc, text: "z".repeat(k + 1), ...H }).doc;
  check("LC-T7-new-thread-at-exactly-1.75MiB-accepted", size(atT) === T && !throws(() => C.addThread(atT, { anchor: anc, text: "n", ...H })), { at: size(atT), T });
  check("LC-T7-new-thread-one-byte-over-refused", size(overT) === T + 1 && throws(() => C.addThread(overT, { anchor: anc, text: "n", ...H }))?.detail?.limit === "newThreadBytes");
  // LC-T7: the cap re-checked after a conflict: at exactly 1.75 MiB a new thread is admitted, but a contender's thread
  // landed first, so the retry, re-read and re-checked, is "full" (the contender's kept, nothing of mine written)
  const S4 = store(C.serialize(atT)); let once = true;
  const race = { read: S4.io.read, write: async (c, b) => { if (once) { once = false; await S4.io.write(C.serialize(C.addThread(C.parse(S4.get()), { anchor: anc, text: "theirs", ...A }).doc), b); } return S4.io.write(c, b); } };
  const re = await C.update(race, (doc) => C.addThread(doc, { anchor: anc, text: "mine", ...H }), nosleep).catch((e) => e);
  const after4 = C.parse(S4.get());
  check("LC-T7-cap-revalidated-after-conflict", re.code === "full" && re.detail?.limit === "newThreadBytes" && after4.threads.some((x) => x.messages[0].text.value === "theirs") && !after4.threads.some((x) => x.messages[0].text.value === "mine"), { code: re.code });
  // LC-T7: replies past 1.75 MiB are taken until the hard 2 MiB limit, which refuses atomically (the file unchanged)
  const S5 = store(C.serialize(atT)); let re5 = null, replies = 0;
  for (let i = 0; !re5 && i < 200; i++) {
    const cur = C.parse(S5.get()), tid = cur.threads[i % cur.threads.length].id, before = S5.get();
    re5 = await C.update(S5.io, (doc) => C.reply(doc, tid, { text: "r".repeat(8000), ...A }), nosleep).then(() => null, (e) => e);
    if (re5) check("LC-T7-2MiB-refusal-atomic", re5.code === "limit" && S5.get() === before && new TextEncoder().encode(before).length <= C.LIMITS.sidecarBytes, { code: re5.code }); else replies++;
  }
  check("LC-T7-replies-until-2MiB", re5 && replies > 20, { replies });
}

// ---- DB3-BUDGET-1 / LC316-A3: the work budget is a hard bound (each step charged before it runs), and the steps a
// page runs between frames give what resolve gives
{
  const para = (i) => `Paragraph ${i}: ordinary words with a phrase numbered ${i}.\n\n`;
  let big = ""; for (let i = 0; big.length < (1 << 20); i++) big += para(i);
  const anchors = Array.from({ length: 40 }, (_, k) => { const q = `a phrase numbered ${k * 97}.`, s = big.indexOf(q); return { ...C.makeAnchor(big, s, s + q.length, undefined, "x"), textSha: "stale" }; });
  // (each of the 40 moved anchors scans the whole 1 MiB text: 3 and 5 Mi run out, the default 64 Mi doesn't)
  for (const budget of [3 << 20, 5 << 20, C.LIMITS.workBudget]) {
    const R = C.resolver(big, budget), st = anchors.map((a) => R.resolve(a).status);
    check("DB3-BUDGET-1-hard-bound-" + (budget >> 20) + "Mi", R.work() <= budget && st.every((x) => x === "moved" || x === "unresolved") && st.includes("unresolved") === (budget < C.LIMITS.workBudget), { work: R.work(), budget, st: st.join(",").slice(0, 200) });
  }
  const R1 = C.resolver(big), R2 = C.resolver(big);
  let yields = 0, same = true;
  for (const a of anchors) { const g = R2.steps(a); let r; for (;;) { r = g.next(); if (r.done) break; yields++; } if (JSON.stringify(r.value) !== JSON.stringify(R1.resolve(a))) same = false; }
  check("LC316-A3-steps-same-as-resolve", same && yields >= anchors.length && R1.work() === R2.work(), { yields, w1: R1.work(), w2: R2.work() });
}

// ---- PR 316's source limit: comments on a .tex of at most 2 Mi UTF-16 units; one more is refused, by the resolver and
// by makeAnchor, with the size in the message
{
  const at = "x".repeat(C.LIMITS.sourceUnits), over = at + "y";
  check("source-limit-exactly-2Mi-ok", !throws(() => C.resolver(at)) && !throws(() => C.makeAnchor(at, 0, 1)));
  const e1 = throws(() => C.resolver(over)), e2 = throws(() => C.makeAnchor(over, 0, 1));
  check("source-limit-one-over-refused", e1?.code === "limit" && e1.detail?.limit === "sourceUnits" && e2?.code === "limit" && /up to 2 MiB \(this one is 2\.0 MiB\)/.test(e1.message), e1?.message);
}

// ---- (#316 r4) the hasher's reused encode buffer: in 8 Ki-unit pieces (and pieces of every size, the buffer grown
// and reused), the digest is the same as in one call and as node's own SHA-256 of the UTF-8 bytes, on each fixture
{
  const fixtures = [TEX, "", "\u00e9t\u00e9 \u{1F600} \u{1D4AA}", "\u{1F600}".repeat(9000) + "a", ("caf\u00e9 \u4e2d\u6587 ").repeat(5000), "x".repeat(70000)];
  const node = (x) => createHash("sha256").update(Buffer.from(new TextEncoder().encode(x))).digest("hex");
  let same = true;
  for (const f of fixtures) {
    for (const piece of [1 << 13, 1, 7, 64, 1 << 16]) {
      const h = C.sha256Hasher();
      for (let i = 0; i < f.length;) { const j = C.sliceAt(f, i + piece); h.update(f.slice(i, j)); i = j; }
      if (h.digest() !== C.sha256(f) || C.sha256(f) !== node(f)) same = false;
    }
  }
  check("r4-hasher-reused-buffer-same-digest", same);
  // (r6) the page's schedule, sha256Steps: 256 units, doubling to 8 Ki; a text across several doublings, a lone high
  // and a lone low surrogate at piece edges, and pairs across them: the same digest as one call and as node's (the
  // lone high surrogate at the first edge makes that piece 257 units: a piece never ends on a high surrogate)
  const run = (t, first, max) => { const g = C.sha256Steps(t, first, max), sizes = []; for (;;) { const x = g.next(); if (x.done) return { d: x.value, sizes }; sizes.push(x.value.size); } };
  const edgy = "a".repeat(255) + "\uD800" + "b".repeat(255) + "\uDC00" + "c".repeat(1022) + "\u{1F600}" + "d".repeat(2046) + "\uD83D" + "e".repeat(20000) + "\u{1D4AA}".repeat(5000);
  const e = run(edgy, 256, 1 << 13);
  check("r6-hash-steps-same-digest", e.d === C.sha256(edgy) && e.d === node(edgy) && e.sizes[0] === 257 && e.sizes.slice(0, 6).every((n, k) => Math.abs(n - 256 * 2 ** k) <= 1) && Math.max(...e.sizes) <= (1 << 13) + 1 && e.sizes.reduce((a, b) => a + b, 0) === edgy.length, { sizes: e.sizes.slice(0, 8) });
  check("r6-hash-steps-fixtures", fixtures.every((f) => run(f, 256, 1 << 13).d === node(f)));
}

// ---- (astra, #316 r2) the first pass over the text is admitted too: a budget below it reads nothing (no hash, no
// copy), and every anchor is unresolved, the work 0; at exactly it, the text is read
{
  const big = "x".repeat(2 << 20), copies = [];
  const R = C.resolver(big, 3 << 20, { onCopy: (x, y) => copies.push([x, y]) });
  const r = R.resolve({ start: 0, end: 1, textSha: "nope", quote: "x", prefix: "", suffix: "" });
  check("budget-initial-pass-admitted", R.work() === 0 && R.work() <= (3 << 20) && R.textSha === null && r.status === "unresolved" && copies.length === 0 && R.context(0, 1) === "", { work: R.work(), r, copies: copies.length });
  const R2 = C.resolver("abc", 6), a2 = C.makeAnchor("abc", 0, 1);
  check("budget-initial-pass-exactly", R2.work() === 6 && R2.resolve(a2).status === "exact");
}

// ---- DB3-BUDGET-1-R1: no copy of the source before its charge: with less budget left than the next step needs (a
// short range's piece; a context line), the step is refused without copying anything (the onCopy seam sees every copy)
{
  const short = "\\begin{document}\nAlpha words. Beta words here. Gamma words.\n\\end{document}\n";   // under a window: a copy
  const a = { start: 30, end: 40, textSha: "stale", quote: "", prefix: "Alpha words. ", suffix: " here." };
  const piece = short.length;                                   // find(prefix) copies the whole short text
  const copies = [];
  const R = C.resolver(short, 2 * short.length + piece - 1, { onCopy: (x, y) => copies.push([x, y]) });
  const r = R.resolve(a);
  check("DB3-BUDGET-1-R1-short-find-refused-before-copy", r.status === "unresolved" && copies.length === 0 && R.work() === 2 * short.length, { r, copies, work: R.work() });
  // the same with one more unit: the copy happens, charged
  const copies2 = [], R2 = C.resolver(short, 2 * short.length + piece, { onCopy: (x, y) => copies2.push([x, y]) });
  R2.resolve(a);
  check("DB3-BUDGET-1-R1-short-find-copy-charged", copies2.length >= 1 && copies2[0][1] - copies2[0][0] === piece && R2.work() >= 2 * short.length + piece, { copies2, work: R2.work() });
  // context: a line it can't afford isn't copied
  const lines = "line one\nline two is longer\nline three\n", copies3 = [];
  const R3 = C.resolver(lines, 2 * lines.length + 5, { onCopy: (x, y) => copies3.push([x, y]) });
  const ctx = R3.context(10, 12);
  check("DB3-BUDGET-1-R1-context-refused-before-copy", copies3.length === 0 && ctx === "" && R3.work() === 2 * lines.length, { copies3, ctx, work: R3.work() });
  const copies4 = [], R4 = C.resolver(lines, 2 * lines.length + 8, { onCopy: (x, y) => copies4.push([x, y]) });
  const ctx4 = R4.context(10, 12);
  check("DB3-BUDGET-1-R1-context-each-line-charged-first", ctx4 === "line one" && copies4.length === 1 && R4.work() === 2 * lines.length + 8, { copies4, ctx4, work: R4.work() });
}

// ---- LC316-A1: the 2 MiB bound on reading is in UTF-8 bytes, as on writing: multibyte text at, and one byte over
{
  const enc = (x) => new TextEncoder().encode(x).length, LIM = C.LIMITS.sidecarBytes;
  const anc = C.makeAnchor(TEX, 0, 5);
  const one = C.addThread(C.emptyDoc({}), { anchor: anc, text: "中".repeat(2000), ...H }).doc.threads[0];
  const doc = C.emptyDoc({}); let k = 0;
  const file = (d) => JSON.stringify(d, null, 1) + "\n";
  while (enc(file(doc)) < LIM - 12000) doc.threads.push({ ...JSON.parse(JSON.stringify(one)), id: "t_" + String(k++).padStart(16, "0") });
  // the last thread's text set so the file is exactly 2 MiB: three-byte characters, then one-byte ones
  const last = JSON.parse(JSON.stringify(one)); last.id = "t_last"; last.messages[0].text.value = ""; doc.threads.push(last);
  const need = LIM - enc(file(doc)), cjk = Math.min(Math.floor(need / 3), 7000), ascii = need - 3 * cjk;
  last.messages[0].text.value = "中".repeat(cjk) + "x".repeat(ascii);
  const atLim = file(doc);
  last.messages[0].text.value += "x";
  const overLim = file(doc);
  check("LC316-A1-multibyte-at-2MiB-read", enc(atLim) === LIM && atLim.length < LIM && !throws(() => C.parse(atLim)), { bytes: enc(atLim), units: atLim.length });
  const oe = throws(() => C.parse(overLim));
  check("LC316-A1-multibyte-one-over-refused", enc(overLim) === LIM + 1 && overLim.length < LIM && oe?.code === "limit" && oe.detail?.size === LIM + 1, { bytes: enc(overLim), code: oe?.code });
  check("LC316-A1-read-and-write-agree", throws(() => C.serialize(C.parse(atLim))) === null || throws(() => C.serialize(C.parse(atLim)))?.code === "limit");
  globalThis.__overLim = overLim;
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
