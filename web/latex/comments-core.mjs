// Comments on a LaTeX document: the file format, its merge and the anchors (plan latex-comments r4.1). Pure: no DOM, no
// I/O, the same in the page, the CLI (scripts/latex-comments.mjs) and the MCP tools, so they can't disagree.
// The comments of paper.tex live beside it in paper.tex.comments.json (format "sagebrush-latex-comments", version 1;
// web/latex/COMMENTS-FORMAT.md). Offsets are JS string indices (UTF-16 units) into the .tex text.

export const FORMAT = "sagebrush-latex-comments";
export const VERSION = 1;
/** A range the resolver searches in a copy (a short one), and the piece of a long span it hashes in one step. */
const WINDOW = 1 << 17;
/** r3 §7.4 and r4.1 §8: one admission and output contract. */
export const LIMITS = {
  // (sourceUnits: comments on a .tex of at most 2 Mi UTF-16 units, its length as a JS string; the editor opens files up
  // to 4 MiB, and above this limit shows that comments aren't available for it: @sagebrush, PR 316)
  sidecarBytes: 2 << 20, newThreadBytes: 1.75 * (1 << 20), threadBytes: 256 << 10, sourceUnits: 2 << 20,
  liveThreads: 2000, threads: 4000, messages: 200, text: 8000, author: 100, id: 64,
  quoteFull: 600, quoteHead: 300, context: 32, shown: 300, candidates: 64, workBudget: 64 << 20,
  listThreads: 200, listBytes: 1 << 20, summaryUnits: 500, contextLines: 3, contextLineUnits: 200, changedWindow: 2000,
  attempts: 5, backoffMs: [50, 100, 200, 400], deadlineMs: 10000,
};

export class CommentsError extends Error {
  constructor(code, message, detail) { super(message); this.code = code; this.detail = detail; }
}
const fail = (code, msg, detail) => { throw new CommentsError(code, msg, detail); };

// ---- SHA-256 (synchronous, of a string's UTF-8 bytes), so anchors hash the same everywhere
const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
/** An incremental SHA-256 of a string's UTF-8 bytes: update(piece) any number of times (pieces never split a
 * surrogate pair: the caller's slicing, sliceAt), then digest(). sha256(s) is the same in one call. */
export function sha256Hasher() {
  const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]), W = new Uint32Array(64);
  const r = (x, k) => (x >>> k) | (x << (32 - k));
  const pend = new Uint8Array(64); let np = 0, total = 0;
  const block = (b, o) => {
    for (let i = 0; i < 16; i++) W[i] = (b[o + 4 * i] << 24) | (b[o + 4 * i + 1] << 16) | (b[o + 4 * i + 2] << 8) | b[o + 4 * i + 3];
    for (let i = 16; i < 64; i++) { const s0 = r(W[i - 15], 7) ^ r(W[i - 15], 18) ^ (W[i - 15] >>> 3), s1 = r(W[i - 2], 17) ^ r(W[i - 2], 19) ^ (W[i - 2] >>> 10); W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0; }
    let [a, bb, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0, t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += bb; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  };
  const bytes = (b) => {
    total += b.length; let i = 0;
    if (np) { while (np < 64 && i < b.length) pend[np++] = b[i++]; if (np < 64) return; block(pend, 0); np = 0; }
    for (; i + 64 <= b.length; i += 64) block(b, i);
    while (i < b.length) pend[np++] = b[i++];
  };
  return {
    update(piece) { bytes(new TextEncoder().encode(piece)); return this; },
    digest() {
      const bits = total * 8, tail = new Uint8Array(((np + 9 + 63) >> 6) << 6);
      tail.set(pend.subarray(0, np)); tail[np] = 0x80;
      for (let i = 0; i < 8; i++) tail[tail.length - 1 - i] = i < 4 ? (bits >>> (8 * i)) & 255 : Math.floor(bits / 2 ** (8 * i)) & 255;
      for (let o = 0; o < tail.length; o += 64) block(tail, o);
      return [...H].map((x) => x.toString(16).padStart(8, "0")).join("");
    },
  };
}
export const sha256 = (str) => sha256Hasher().update(str).digest();
/** Where to cut a string near `i` for slicing (never inside a surrogate pair). */
export const sliceAt = (s, i) => (i < s.length && i > 0 && (s.charCodeAt(i - 1) & 0xfc00) === 0xd800 ? i + 1 : Math.min(i, s.length));

// ---- ids, times, registers (r3 §7.1, r4 §8.1): {value, rev, time, by, op}, merged by the greatest (rev, time, by, op);
// op is a fresh random id per write, so two distinct writes never tie
export const newId = (prefix) => prefix + "_" + Array.from({ length: 16 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
export const now = () => new Date().toISOString();
export const reg = (value, by, time = now(), rev = 0) => ({ value, rev, time, by, op: newId("o") });
// (the value, by its JSON, last: two writes with one op id, which a fresh random id makes vanishingly rare, still
// merge the same in either order)
const later = (a, b) => (a.rev !== b.rev ? a.rev > b.rev : a.time !== b.time ? a.time > b.time : a.by !== b.by ? a.by > b.by : a.op !== b.op ? a.op > b.op : JSON.stringify(a.value) > JSON.stringify(b.value));
const pick = (a, b) => (!a ? b : !b ? a : later(b, a) ? b : a);
/** A register's next write: one rev above the one read. */
export const bump = (r, value, by, time = now()) => ({ value, rev: (r?.rev ?? -1) + 1, time, by, op: newId("o") });

/** An empty comments document for a .tex (its fid and path). */
export const emptyDoc = (file = {}) => ({ format: FORMAT, version: VERSION, file: { fid: file.fid ?? null, path: file.path ?? null }, threads: [] });

const utf8 = (s) => new TextEncoder().encode(s).length;
// ---- admission (r3 §7.4): checked before anything is written; a refusal names the limit and the size
const str = (v, max, what) => { if (typeof v !== "string") fail("invalid", what + " must be a string"); if (v.length > max) fail("limit", what + " is over " + max, { limit: what, max, size: v.length }); return v; };
const isReg = (r) => r && typeof r === "object" && Number.isInteger(r.rev) && r.rev >= 0 && typeof r.time === "string" && typeof r.by === "string" && typeof r.op === "string";
function checkAnchor(a) {
  if (!a || typeof a !== "object") fail("invalid", "anchor");
  for (const k of ["start", "end"]) if (!Number.isInteger(a[k]) || a[k] < 0) fail("invalid", "anchor." + k);
  if (a.end < a.start) fail("invalid", "anchor.end < start");
  str(a.quote ?? "", LIMITS.quoteFull, "anchor.quote"); str(a.prefix ?? "", LIMITS.context, "anchor.prefix"); str(a.suffix ?? "", LIMITS.context, "anchor.suffix");
  if (a.tail !== undefined) { str(a.tail, LIMITS.quoteHead, "anchor.tail"); if (!Number.isInteger(a.length) || typeof a.sha !== "string") fail("invalid", "a long anchor needs length and sha"); }
  if (a.shown !== undefined) str(a.shown, LIMITS.shown, "anchor.shown");
}
/** The document checked against the format and every limit (throws CommentsError: invalid | limit | version). */
export function validate(doc) {
  if (!doc || doc.format !== FORMAT) fail("invalid", "not a " + FORMAT + " document");
  if (doc.version !== VERSION) fail("version", "version " + doc.version + " is not supported (this reads " + VERSION + ")");
  if (!Array.isArray(doc.threads)) fail("invalid", "threads");
  if (doc.threads.length > LIMITS.threads) fail("limit", "threads", { limit: "threads", max: LIMITS.threads, size: doc.threads.length });
  if (doc.threads.filter((t) => !t.deleted?.value).length > LIMITS.liveThreads) fail("limit", "live threads", { limit: "liveThreads", max: LIMITS.liveThreads });
  const ids = new Set();
  for (const t of doc.threads) {
    str(t.id, LIMITS.id, "thread.id"); if (ids.has(t.id)) fail("invalid", "duplicate thread id " + t.id); ids.add(t.id);
    if (!isReg(t.anchor) || !isReg(t.resolved) || !isReg(t.deleted)) fail("invalid", "thread " + t.id + " registers");
    checkAnchor(t.anchor.value);
    if (!Array.isArray(t.messages) || t.messages.length > LIMITS.messages) fail("limit", "messages", { limit: "messages", max: LIMITS.messages, size: t.messages?.length });
    for (const m of t.messages) { str(m.id, LIMITS.id, "message.id"); str(m.author, LIMITS.author, "author"); if (!isReg(m.text) || !isReg(m.deleted)) fail("invalid", "message registers"); str(m.text.value, LIMITS.text, "text"); }
    const tb = utf8(JSON.stringify(t)); if (tb > LIMITS.threadBytes) fail("limit", "thread " + t.id + " is over 256 KiB", { limit: "threadBytes", max: LIMITS.threadBytes, size: tb });
  }
  return doc;
}
/** The file's text parsed and validated (a missing file: null gives an empty document). */
export function parse(text, file) {
  if (text === null || text === undefined) return emptyDoc(file);
  // (its UTF-8 length, always: a file of multibyte text is over 2 MiB long before its UTF-16 length is)
  const n = text.length > LIMITS.sidecarBytes ? text.length : utf8(text);
  if (n > LIMITS.sidecarBytes) fail("limit", "the comments file is over 2 MiB", { limit: "sidecarBytes", max: LIMITS.sidecarBytes, size: n });
  let doc; try { doc = JSON.parse(text); } catch { fail("invalid", "the comments file isn't JSON"); }
  return validate(doc);
}
/** The document as the file's text (checked first: a document over the limits is never written). */
export function serialize(doc) {
  validate(doc);
  const s = JSON.stringify(doc, null, 1) + "\n";
  if (new TextEncoder().encode(s).length > LIMITS.sidecarBytes) fail("limit", "the comments file would be over 2 MiB", { limit: "sidecarBytes", max: LIMITS.sidecarBytes });
  return s;
}

// ---- anchors (r3 §7.3): a span of the text, with what is needed to find it again
/** Comments are for a .tex of at most 2 Mi UTF-16 units (LIMITS.sourceUnits): a longer one is refused, "limit". */
export function sourceFits(text) {
  if (text.length > LIMITS.sourceUnits) fail("limit", "comments are available for documents up to 2 MiB (this one is " + (text.length / (1 << 20)).toFixed(1) + " MiB)", { limit: "sourceUnits", max: LIMITS.sourceUnits, size: text.length });
}
/** An anchor for [start, end) of `text`: the whole span (up to 600 units), or its head, tail, length and sha
 * (`textSha`: the text's, when the caller has it already). */
export function makeAnchor(text, start, end, shown, textSha) {
  sourceFits(text);
  if (!(Number.isInteger(start) && Number.isInteger(end) && 0 <= start && start <= end && end <= text.length)) fail("invalid", "a range inside the text");
  const span = text.slice(start, end);
  const a = { start, end, textSha: textSha ?? sha256(text), prefix: text.slice(Math.max(0, start - LIMITS.context), start), suffix: text.slice(end, end + LIMITS.context) };
  if (span.length <= LIMITS.quoteFull) a.quote = span;
  else { a.quote = span.slice(0, LIMITS.quoteHead); a.tail = span.slice(-LIMITS.quoteHead); a.length = span.length; a.sha = sha256(span); }
  const sh = (shown ?? "").trim().slice(0, LIMITS.shown);
  if (sh && sh !== span) a.shown = sh;
  return a;
}

/** Line starts of a text, built once and reused (r3 §7.6); line and column are 1-based, columns in UTF-16 units. */
export function lineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  const at = (off) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= off) lo = m; else hi = m - 1; } return { line: lo + 1, col: off - starts[lo] + 1 }; };
  const off = (line, col) => (line >= 1 && line <= starts.length ? Math.min(starts[line - 1] + col - 1, line < starts.length ? starts[line] - 1 : text.length) : -1);
  return { starts, at, off, lines: starts.length };
}

/** A resolver over one text: shared work (one hash, one line index) and one work budget for every anchor resolved
 * through it (r3 §7.6, r4 §8.5: every inspection of the source is charged: the hash, each search's span, each long
 * span's hash, each pairing step, each extraction), never exceeded: a step is charged before it runs, and an anchor
 * whose next step doesn't fit is "unresolved" (budget). resolve(anchor) -> {status, start, end, candidates?}; status:
 * exact | moved | changed | ambiguous | orphaned | unresolved (never a guess). steps(anchor) is the same as a generator
 * that yields between bounded steps (a window of the text searched, a piece of a long span hashed), so the page can
 * give the main thread back between them; its return value is resolve's. */
export function resolver(text, budget = LIMITS.workBudget, { textSha: known, onCopy } = {}) {
  sourceFits(text);
  // (the text's hash, the caller's when it hashed the text already in slices (the page), and its line index, built
  // when first needed: both charged here, the same either way)
  // (the first pass over the text, its hash and its line index, is admitted against the budget like every step: a
  // budget that can't pay for it leaves the text unread, and every anchor unresolved)
  const first = 2 * text.length, starved = first > budget;
  let work = starved ? 0 : first;
  const textSha = starved ? null : known ?? sha256(text);
  let lineIdx = null;
  const lines = () => (lineIdx ??= lineIndex(text));
  const can = (n) => work + n <= budget;
  // every copy of the source goes through here, after its length was checked against the budget and charged
  // (onCopy: the tests' seam, told each copy's span)
  const copy = (a, b) => { onCopy?.(a, b); return text.slice(a, b); };
  const OUT = Symbol("budget");
  // every occurrence of s starting in [from, to) (up to the candidate cap + 1). A short range (at most a window) is
  // searched in a copy of it, charged first. A longer one is searched in place, one occurrence at a time (a step,
  // yielded after): each search may run to the text's end, so that much must fit in the budget before it starts (else
  // OUT), and what it scanned is charged. No copies of the text are made: a step is one native search, at most 2 Mi
  // units (about a millisecond or two), and no garbage piles up between steps.
  function* find(s, from = 0, to = text.length) {
    const out = [];
    if (!s) return out;
    const end = Math.min(to, text.length);
    if (end - from <= WINDOW) {
      const pe = Math.min(text.length, end + s.length - 1), n = Math.max(0, pe - from);
      if (!can(n)) return OUT;
      work += n;
      const piece = copy(from, pe);
      for (let i = piece.indexOf(s); i >= 0 && from + i < end; i = piece.indexOf(s, i + 1)) { out.push(from + i); if (out.length > LIMITS.candidates) break; }
      return out;
    }
    for (let at = from; at < end && out.length <= LIMITS.candidates;) {
      const rest = text.length - at;
      if (!can(rest)) return OUT;
      const i = text.indexOf(s, at);
      work += i < 0 ? rest : i - at + s.length;
      if (i < 0 || i >= end) break;
      out.push(i); at = i + 1;
      yield;
    }
    return out;
  }
  // the SHA-256 of [a, b), a piece at a time, each charged before it is hashed
  function* sha(a, b) {
    const h = sha256Hasher();
    for (let i = a; i < b;) { const j = Math.min(b, sliceAt(text, i + WINDOW)); if (!can(j - i)) return OUT; work += j - i; h.update(copy(i, j)); i = j; yield; }
    return h.digest();
  }
  // the whole span at i, if the anchor's quote (head; and for a long one tail, length and sha) is there
  function* spanAt(a, i) {
    if (a.tail === undefined) return { start: i, end: i + a.quote.length };
    const e = i + a.length;
    if (!can(a.tail.length)) return OUT;
    work += a.tail.length;
    if (!(e <= text.length && copy(e - a.tail.length, e) === a.tail)) return null;
    const h = yield* sha(i, e);
    return h === OUT ? OUT : h === a.sha ? { start: i, end: e } : null;
  }
  const ctxExact = (a, s, e) => { work += a.prefix.length + a.suffix.length; return copy(Math.max(0, s - a.prefix.length), s) === a.prefix && copy(e, Math.min(text.length, e + a.suffix.length)) === a.suffix; };
  const UNRESOLVED = { status: "unresolved", reason: "budget" };
  function* steps(a) {
    if (starved) return UNRESOLVED;
    if (a.textSha === textSha && a.end <= text.length) return { status: "exact", start: a.start, end: a.end };
    // moved: one occurrence of the whole quote, or one whose prefix and suffix both still match; several: ambiguous
    if (a.quote) {
      const occ = yield* find(a.quote);
      if (occ === OUT) return UNRESOLVED;
      if (occ.length > LIMITS.candidates) return { status: "ambiguous", reason: "too many", candidates: [] };
      const spans = [];
      for (const i of occ) { const sp = yield* spanAt(a, i); if (sp === OUT) return UNRESOLVED; if (sp) spans.push(sp); }
      if (spans.length === 1) return { status: "moved", ...spans[0] };
      if (spans.length > 1) {
        if (!can(spans.length * (a.prefix.length + a.suffix.length))) return UNRESOLVED;
        const fit = spans.filter((sp) => ctxExact(a, sp.start, sp.end));
        if (fit.length === 1) return { status: "moved", ...fit[0] };
        return { status: "ambiguous", candidates: (fit.length ? fit : spans).map(({ start, end }) => ({ start, end })) };
      }
    }
    // changed: every pair (an occurrence of the prefix, an occurrence of the suffix after it, within the window); an
    // empty prefix means the file's start only, an empty suffix the file's end only; one pair with text between them:
    // changed; more: ambiguous; only white space between them: orphaned (the text was deleted)
    let starts = [];
    if (a.prefix) { const f = yield* find(a.prefix); if (f === OUT) return UNRESOLVED; starts = f.map((i) => i + a.prefix.length); }
    else if (a.start === 0) starts = [0];
    if (starts.length > LIMITS.candidates) return { status: "ambiguous", reason: "too many", candidates: [] };
    const pairs = [];
    for (const s of starts) {
      let ends = [];
      if (a.suffix) { const f = yield* find(a.suffix, s, s + LIMITS.changedWindow + 1); if (f === OUT) return UNRESOLVED; ends = f; }
      else if (text.length - s <= LIMITS.changedWindow) ends = [text.length];
      if (!can(ends.length)) return UNRESOLVED;
      work += ends.length;
      for (const e of ends) { if (e - s <= LIMITS.changedWindow) pairs.push({ start: s, end: e }); if (pairs.length > LIMITS.candidates) return { status: "ambiguous", reason: "too many", candidates: [] }; }
    }
    // (nothing but white space left between them: the commented text was deleted, not rewritten: removed)
    if (!can(pairs.reduce((n, p) => n + p.end - p.start, 0))) return UNRESOLVED;
    const kept = pairs.filter((p) => { work += p.end - p.start; return copy(p.start, p.end).trim() !== ""; });
    if (kept.length === 1) return { status: "changed", ...kept[0] };
    if (kept.length > 1) return { status: "ambiguous", candidates: kept };
    return pairs.length ? { status: "orphaned", reason: "removed" } : { status: "orphaned" };
  }
  const resolve = (a) => { const g = steps(a); for (;;) { const r = g.next(); if (r.done) return r.value; } };
  // a span's lines around it (the units copied charged; cut short, never over the budget)
  const context = (s, e) => {
    if (starved) return "";
    const L = lines(), l0 = L.at(s).line, l1 = L.at(e).line, from = Math.max(1, l0 - LIMITS.contextLines), to = Math.min(L.lines, l1 + LIMITS.contextLines);
    const out = [];
    for (let l = from; l <= to; l++) {
      const a = L.starts[l - 1], b = l < L.lines ? L.starts[l] - 1 : text.length, pe = Math.min(b, a + LIMITS.contextLineUnits);
      if (!can(pe - a)) break;
      work += pe - a; out.push(copy(a, pe) + (b - a > LIMITS.contextLineUnits ? "…" : ""));
    }
    return out.join("\n");
  };
  return { textSha, get lines() { return lines(); }, resolve, steps, context, work: () => work };
}

// ---- the operations: each returns a new document (the input is never changed) and checks admission first
const clone = (d) => JSON.parse(JSON.stringify(d));
const live = (t) => !t.deleted.value;
const threadOf = (doc, id) => { const t = doc.threads.find((x) => x.id === id); if (!t || t.deleted.value) fail("gone", "no thread " + id + " (deleted?)"); return t; };
const message = (author, text, time) => ({ id: newId("m"), author: str(author, LIMITS.author, "author"), time, text: reg(str(text, LIMITS.text, "text"), author, time), deleted: reg(false, author, time) });
const fileBytes = (doc) => utf8(JSON.stringify(doc, null, 1)) + 1;
const threadFits = (t) => { const b = utf8(JSON.stringify(t)); if (b > LIMITS.threadBytes) fail("full", "this thread is full: start a new one", { limit: "threadBytes", max: LIMITS.threadBytes, size: b }); };

/** A new thread on `anchor` with a first message (refused at the caps, or once the file is over 1.75 MiB). */
export function addThread(doc, { anchor, text, author, time = now() }) {
  checkAnchor(anchor);
  if (doc.threads.filter(live).length >= LIMITS.liveThreads) fail("full", "too many comments: resolve or delete some", { limit: "liveThreads", max: LIMITS.liveThreads });
  if (doc.threads.length >= LIMITS.threads) fail("full", "this document has had too many comments; rename its comments file to start a new one", { limit: "threads", max: LIMITS.threads });
  if (fileBytes(doc) > LIMITS.newThreadBytes) fail("full", "the comments file is nearly full (1.75 MiB): resolve or delete some, or start a new comments file", { limit: "newThreadBytes", max: LIMITS.newThreadBytes });
  const d = clone(doc), id = newId("t");
  const t = { id, created: time, anchor: reg(anchor, author, time), resolved: reg(false, author, time), deleted: reg(false, author, time), messages: [message(author, text, time)] };
  threadFits(t); d.threads.push(t);
  return { doc: d, id };
}
export function reply(doc, id, { text, author, time = now() }) {
  const d = clone(doc), t = threadOf(d, id);
  if (t.messages.length >= LIMITS.messages) fail("full", "this thread is full: start a new one", { limit: "messages", max: LIMITS.messages });
  t.messages.push(message(author, text, time)); threadFits(t); return { doc: d, id };
}
export function setResolved(doc, id, value, { author, time = now() }) { const d = clone(doc), t = threadOf(d, id); t.resolved = bump(t.resolved, !!value, author, time); return { doc: d, id }; }
/** A thread deleted: a tombstone, its texts cleared by a higher rev (r4 §8.2: no compaction; a stale copy loses). */
export function deleteThread(doc, id, { author, time = now() }) {
  const d = clone(doc), t = threadOf(d, id);
  t.deleted = bump(t.deleted, true, author, time);
  for (const m of t.messages) m.text = bump(m.text, "", author, time);
  t.anchor = bump(t.anchor, { start: 0, end: 0, quote: "", prefix: "", suffix: "" }, author, time);
  return { doc: d, id };
}
export function reattach(doc, id, anchor, { author, time = now() }) { checkAnchor(anchor); const d = clone(doc), t = threadOf(d, id); t.anchor = bump(t.anchor, anchor, author, time); threadFits(t); return { doc: d, id }; }
export function editMessage(doc, id, mid, { text, author, time = now() }) {
  const d = clone(doc), t = threadOf(d, id), m = t.messages.find((x) => x.id === mid && !x.deleted.value);
  if (!m) fail("gone", "no message " + mid); m.text = bump(m.text, str(text, LIMITS.text, "text"), author, time); threadFits(t); return { doc: d, id };
}
export function deleteMessage(doc, id, mid, { author, time = now() }) {
  const d = clone(doc), t = threadOf(d, id), m = t.messages.find((x) => x.id === mid && !x.deleted.value);
  if (!m) fail("gone", "no message " + mid); m.deleted = bump(m.deleted, true, author, time); m.text = bump(m.text, "", author, time); return { doc: d, id };
}

// ---- merge (r3 §7.1, r4 §8.1, §8.2): records by id (their union: nothing is dropped, tombstones are kept), registers
// by the greatest (rev, time, by, op); the same on every replica, in any order
export function merge(a, b) {
  const out = clone(a);
  const byId = new Map(out.threads.map((t) => [t.id, t]));
  for (const t of b.threads) {
    const mine = byId.get(t.id);
    if (!mine) { const c = clone(t); out.threads.push(c); byId.set(c.id, c); continue; }
    if (t.created < mine.created) mine.created = t.created;
    for (const k of ["anchor", "resolved", "deleted"]) mine[k] = clone(pick(mine[k], t[k]));
    const ms = new Map(mine.messages.map((m) => [m.id, m]));
    for (const m of t.messages) {
      const x = ms.get(m.id);
      if (!x) { mine.messages.push(clone(m)); continue; }
      x.text = clone(pick(x.text, m.text)); x.deleted = clone(pick(x.deleted, m.deleted));
    }
    mine.messages.sort((p, q) => (p.time < q.time ? -1 : p.time > q.time ? 1 : p.id < q.id ? -1 : 1));
  }
  out.threads.sort((p, q) => (p.created < q.created ? -1 : p.created > q.created ? 1 : p.id < q.id ? -1 : 1));
  return out;
}

// ---- writing with retries (r3 §7.7, r4 §8.6): io = { read({signal}): Promise<{content: string|null, base}>,
// write(content, base, {signal}): Promise<unknown> }, write throwing an error with code "conflict" on a
// compare-and-swap miss. Only conflicts are retried: 5 attempts in all, each re-reading, re-validating and
// re-applying `op` (doc -> {doc, id}). One monotonic deadline (10 s) covers every step: checked before each attempt,
// read, write and wait; calls get an AbortSignal for it; a call that can't be cancelled may overrun by its own
// duration. Running out of attempts or time is "busy", with the draft kept in the error.
const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
export async function update(io, op, { file, draft, deadlineMs = LIMITS.deadlineMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const end = clock() + deadlineMs;
  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => ac?.abort(), deadlineMs);
  const busy = (attempts, why) => fail("busy", why + "; nothing was saved", { draft, attempts });
  try {
    for (let attempt = 1; ; attempt++) {
      if (clock() >= end) busy(attempt - 1, "out of time");
      const { content, base } = await io.read({ signal: ac?.signal });
      const res = op(parse(content, file));       // (invalid, limit, full, gone: not retried)
      const text = serialize(res.doc);
      if (clock() >= end) busy(attempt - 1, "out of time");
      try { await io.write(text, base, { signal: ac?.signal }); return { doc: res.doc, id: res.id, attempts: attempt }; }
      catch (e) {
        // (any failure but a conflict may have come after the write was done, a timeout or an abort: the file is read
        // once more, and if it already holds everything this write had, it was saved; else the failure stands, and
        // nothing of this write is there, so a retry by the caller can't duplicate it)
        if (e?.code !== "conflict") {
          const landed = await reconcile(io, res.doc, file);
          if (landed) return { doc: landed, id: res.id, attempts: attempt, reconciled: true };
          if (ac?.signal.aborted) busy(attempt, "out of time");
          throw e;
        }
        if (attempt >= LIMITS.attempts) busy(attempt, "the comments file kept changing (" + attempt + " attempts)");
        const ms = Math.round(LIMITS.backoffMs[attempt - 1] * (0.75 + Math.random() * 0.5));
        if (clock() + ms >= end) busy(attempt, "out of time");
        await sleep(ms);
      }
    }
  } finally { clearTimeout(timer); }
}

// the file now, if it holds everything `mine` has (merging mine into it changes nothing); else null. Read without the
// operation's deadline (it may be what ended the write), bounded on its own.
async function reconcile(io, mine, file) {
  const ac = typeof AbortController !== "undefined" ? new AbortController() : null, timer = setTimeout(() => ac?.abort(), 2000);
  try {
    const { content } = await io.read({ signal: ac?.signal });
    const cur = parse(content, file);
    return JSON.stringify(merge(cur, mine)) === JSON.stringify(merge(cur, cur)) ? cur : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

// ---- reading, for people and agents (r4.1 §8.5): `list` gives thread summaries, `show` one whole thread
const cut = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
const msgView = (m) => ({ id: m.id, author: m.author, agent: m.author.startsWith("agent:"), time: m.time, text: m.text.value });
function placed(R, t) {
  const a = t.anchor.value, r = R.resolve(a), range = (s, e) => ({ start: R.lines.at(s), end: R.lines.at(e) });
  return {
    status: r.status, ...(r.reason ? { reason: r.reason } : {}),
    ...(r.start !== undefined ? { offsets: { start: r.start, end: r.end }, range: range(r.start, r.end), context: R.context(r.start, r.end) } : {}),
    ...(r.candidates ? { candidates: r.candidates.map((c) => ({ offsets: c, range: range(c.start, c.end) })) } : {}),
  };
}
/** Summaries of the live threads (open ones; `all`: resolved too), in id order, at most 200 and 1 MiB a page. The
 * cursor names the files' snapshot: if either changed, the next page is "stale" (list again from the start). */
export function list(doc, text, { all = false, cursor = null, budget } = {}) {
  const snapshot = sha256(JSON.stringify(doc)) + ":" + sha256(text);
  if (cursor && cursor.snapshot !== snapshot) fail("stale", "the comments or the file changed: list again from the start");
  const R = resolver(text, budget);
  const ts = doc.threads.filter((t) => live(t) && (all || !t.resolved.value)).sort((p, q) => (p.id < q.id ? -1 : 1)).filter((t) => !cursor || t.id > cursor.after);
  const out = []; let bytes = 0, i = 0;
  for (; i < ts.length && out.length < LIMITS.listThreads; i++) {
    const t = ts[i], ms = t.messages.filter((m) => !m.deleted.value), a = t.anchor.value;
    const v = { id: t.id, resolved: !!t.resolved.value, ...placed(R, t), quote: cut(a.tail === undefined ? a.quote : a.quote + "…" + a.tail, LIMITS.quoteHead),
      messages: ms.length, authors: [...new Set(ms.map((m) => m.author))],
      first: ms[0] ? { ...msgView(ms[0]), text: cut(ms[0].text.value, LIMITS.summaryUnits) } : null,
      last: ms.length > 1 ? { ...msgView(ms[ms.length - 1]), text: cut(ms[ms.length - 1].text.value, LIMITS.summaryUnits) } : null };
    const b = utf8(JSON.stringify(v)); if (bytes + b > LIMITS.listBytes && out.length) break;
    bytes += b; out.push(v);
  }
  const more = i < ts.length;
  return { threads: out, more, cursor: more ? { snapshot, after: out[out.length - 1].id } : null, work: R.work() };
}
/** One whole thread (it fits one answer: a thread is at most 256 KiB). */
export function show(doc, text, id, { budget } = {}) {
  const t = threadOf(doc, id), a = t.anchor.value, R = resolver(text, budget);
  return { id: t.id, resolved: !!t.resolved.value, ...placed(R, t), quote: a.tail === undefined ? a.quote : a.quote + "…" + a.tail, messages: t.messages.filter((m) => !m.deleted.value).map(msgView) };
}

/** A span named by a quote (exactly one occurrence, or the n-th, 1-based) or by a line/column range. */
export function locateSpan(text, { quote, occurrence, range }) {
  if (range) { const L = lineIndex(text), s = L.off(range.start.line, range.start.col), e = L.off(range.end.line, range.end.col); if (s < 0 || e < s) fail("invalid", "a range inside the text"); return { start: s, end: e }; }
  str(quote ?? "", LIMITS.text, "quote"); if (!quote) fail("invalid", "a quote or a range");
  const occ = []; for (let i = text.indexOf(quote); i >= 0 && occ.length <= LIMITS.candidates; i = text.indexOf(quote, i + 1)) occ.push(i);
  if (!occ.length) fail("missing", "the quote isn't in the file");
  if (occurrence !== undefined) { const i = occ[occurrence - 1]; if (i === undefined) fail("invalid", "there are " + occ.length + " occurrences"); return { start: i, end: i + quote.length }; }
  if (occ.length > 1) { const L = lineIndex(text); fail("ambiguous", "the quote occurs " + occ.length + " times: give --occurrence", { candidates: occ.map((i, k) => ({ occurrence: k + 1, range: { start: L.at(i), end: L.at(i + quote.length) } })) }); }
  return { start: occ[0], end: occ[0] + quote.length };
}
