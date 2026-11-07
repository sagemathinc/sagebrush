// What a document's code may do in this browser: the one host record (William, Nov 2: "it could be _safe_ to run any
// notebook in a mode where it can't mutate the filesystem", and 11:15 PM PST: "enable/disable network - enable/disable
// filesystem io. There's just two parameters"; plan-no-mutation r3, astra's CLEAR 5fe204ad). Named for what they do:
// "File writes" and "Network", never "trust" (William, Nov 6, 9:15 PM PST).
//
// Two switches, unchanged by the confinement spec's phase 1a in what they decide and where they are kept:
//   files    may change the person's files. On for a notebook the person made in this site's own UI (its workspace
//            entry's `made: "person"`, which the host keeps and never reads from the document, a file or a URL) and for
//            one the page made from its own bundled examples ("host"); off for any other (a remote URL, a share link,
//            an upload, a copy of one, provenance unknown, the local server's, a disk file's). The person changes it
//            with a trusted click (the bar's "Allow changes for this notebook", the Permissions panel), kept per
//            document under its own key ("sagebrush-permissions", as before), and an explicit setting beats the default,
//            a reopen included.
//   network  may reach the network: off for every document; nothing reads it yet.
// And the scoped grants of the confinement spec (r3.2 §2, §4.1; William approved the build Nov 6, 9:43 PM PST),
// RECORDED here under their own key ("sagebrush-grants") but not yet enforced anywhere (phase 2 checks write trees,
// phase 3 hosts, phase 4 read trees):
//   write trees, read trees, hosts: each stored ("Allow for this notebook") or for this page's session ("Allow once");
//   denials of a scope, stored or for the session. The latest decision for a scope wins, written at once: a grant
//   removes the scope's denials, a denial its grants, promoting "once" to stored removes the once entry; if the stored
//   record can't be written, nothing changes and the decision is refused (@sagebrush's R2 on #805).
//   Bounded (§4.1 Bounds; R3): at most GRANT_CAPS.perKind of each kind, stored and once together, refused past it;
//   stored denials at most GRANT_CAPS.storedDenials page-wide, the oldest evicted; session denials
//   GRANT_CAPS.sessionDenialsPerDoc a document and GRANT_CAPS.sessionDenialsPage in the page, the oldest evicted (a
//   repeated denial counts as fresh); at most GRANT_CAPS.sessionDocs documents with session entries, refused past it;
//   entries left empty pruned. An evicted denial can only bring a prompt back.
// Checked where a change is made: the interpreter's file layer (web/shims/fs.ts), the page as it keeps a change
// (index.html, at the change and again as its queue writes it), the shell's mutating verbs and the true rename (U11).
// Stored in this browser by the page alone (localStorage: the interpreter, in its opaque-origin frame, can't reach it).

const KEY = "sagebrush-permissions", GRANTS = "sagebrush-grants", HOST_MADE = "sagebrush-host-made";
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
// (the explicit choices kept: allows past ALLOWS_KEPT go, oldest first (a forgotten allow falls back to the default, never
// more than it); a "don't allow" is never dropped to make room (astra's NM-DENY-2): past DENIALS_KEPT it is held in this
// page and set() says it wasn't kept)
export const ALLOWS_KEPT = 2000, DENIALS_KEPT = 20000;
// (the scoped grants' bounds: confinement spec r3.2 §4.1)
export const GRANT_CAPS = Object.freeze({ perKind: 32, pathChars: 1024, hostChars: 253, storedDenials: 20000, sessionDenialsPerDoc: 256, sessionDenialsPage: 4096, sessionDocs: 4096, docsKept: 2000 });
export const GRANT_KINDS = Object.freeze(["write", "read", "net"]);

/** A grant's scope in its one canonical form, or null if it isn't one. Write and read: a workspace folder ("/", or
 * "/a/b"; no ".", ".." or empty segment, no trailing "/"). Net: an exact host with its port explicit, the host
 * lowercase and in its ASCII (IDNA) form, the port normalized first ("H.org", "h.org:443" and "h.org:00443" are all
 * "h.org:443"); no wildcard, scheme, user, path, query or IPv6 literal. The same form for any input that names it, so
 * applying it twice changes nothing. */
export function canonicalScope(kind, scope) {
  if (typeof scope !== "string") return null;
  if (kind === "write" || kind === "read") {
    if (!scope.startsWith("/") || scope.length > GRANT_CAPS.pathChars || /[\u0000-\u001f]/.test(scope)) return null;
    const parts = scope.split("/").slice(1);
    if (parts.length === 1 && parts[0] === "") return "/";
    if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
    return "/" + parts.join("/");
  }
  if (kind === "net") {
    if (scope.length > GRANT_CAPS.hostChars + 6 || /[\s/\\?#@*\[\]]/.test(scope)) return null;
    const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(scope);
    if (!m) return null;
    const port = m[2] === undefined ? 443 : Number(m[2]);
    if (!(port >= 1 && port <= 65535)) return null;
    let host;
    try {
      const u = new URL("https://" + m[1] + "/");
      if (u.username || u.password || u.pathname !== "/" || u.search || u.hash || u.port) return null;
      host = u.hostname;
    } catch { return null; }
    if (!host || host.length > GRANT_CAPS.hostChars || !/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".")) return null;
    return `${host}:${port}`;
  }
  return null;
}
/** Whether a granted scope covers a target: a folder covers itself and what is below it; a host only itself. */
export function scopeCovers(kind, granted, target) {
  if (kind === "net") return granted === target;
  return granted === "/" || target === granted || target.startsWith(granted + "/");
}

/** The page's one record. `doc`: the document's id as the page knows it (a notebook's, "local:…", "file:…"). */
export function createPermissions() {
  const made = new Map(); // doc -> "person" | "host" | "elsewhere" (this page's knowledge of its provenance)
  const listeners = new Set();
  // (the switch choices this page couldn't keep in storage: they hold here, over what storage says, until it closes)
  const unkept = new Map(); // doc -> { files }
  const explicit = () => read(KEY, {});
  const choice = (doc) => unkept.get(doc) ?? explicit()[doc];
  const tell = (doc) => listeners.forEach((f) => f(doc));
  // ---- the scoped record: stored ({v, seq, docs: {doc: {write, read, net: [scope], denied: [[kind, scope, seq]], t}}})
  // and this page's session (doc -> {write, read, net: Set, denied: Map "kind\0scope" -> seq}, insertion = age)
  const session = new Map();
  let sessionSeq = 0, sessionDenials = 0;
  const stored = () => { const r = read(GRANTS, null); return r && r.v === 1 && r.docs && typeof r.docs === "object" ? r : { v: 1, seq: 0, docs: {} }; };
  const key = (kind, s) => kind + "\u0000" + s;
  const empty = (x) => !x || (GRANT_KINDS.every((k) => !(x[k]?.length ?? x[k]?.size)) && !(x.denied?.length ?? x.denied?.size));
  // (a document's session entry, made only within GRANT_CAPS.sessionDocs: null past it; pruned when left empty)
  const sess = (doc, make) => {
    let s = session.get(doc);
    if (!s && make) {
      if (session.size >= GRANT_CAPS.sessionDocs) return null;
      session.set(doc, (s = { write: new Set(), read: new Set(), net: new Set(), denied: new Map() }));
    }
    return s ?? null;
  };
  const prune = (doc) => { const s = session.get(doc); if (s && empty(s)) session.delete(doc); };
  const dropSessionDenial = (s, k) => { if (s?.denied.delete(k)) sessionDenials--; };
  // (the stored record kept within its bounds: past storedDenials denials the oldest go; a document left with nothing
  // goes; past docsKept documents, the ones least recently changed go, which only narrows or brings a prompt back)
  const trim = (r) => {
    const docs = Object.entries(r.docs);
    const denials = docs.flatMap(([d, e]) => (e.denied ?? []).map((x) => [x[2], d, x]));
    if (denials.length > GRANT_CAPS.storedDenials) {
      denials.sort((a, b) => a[0] - b[0]);
      for (const [, d, x] of denials.slice(0, denials.length - GRANT_CAPS.storedDenials)) r.docs[d].denied = r.docs[d].denied.filter((y) => y !== x);
    }
    for (const [d, e] of Object.entries(r.docs)) if (empty(e)) delete r.docs[d];
    const left = Object.entries(r.docs).sort((a, b) => (a[1].t ?? 0) - (b[1].t ?? 0));
    for (const [d] of left.slice(0, Math.max(0, left.length - GRANT_CAPS.docsKept))) delete r.docs[d];
  };
  // (a change to the stored record, written at once: false if it couldn't be, and then nothing stored changed)
  const commit = (doc, change) => {
    const r = stored(), e = (r.docs[doc] ??= {});
    if (!change(e, r)) { if (empty(e)) delete r.docs[doc]; return true; } // (nothing stored changed)
    e.t = ++r.seq;
    trim(r);
    return write(GRANTS, r);
  };
  const api = {
    /** The host, as it opens `doc`: its provenance from its own metadata (absent: unknown, which counts as elsewhere). */
    provenance(doc, how) { made.set(doc, how === "person" || how === "host" ? how : "elsewhere"); tell(doc); },
    /** Whether `doc`'s code may do `perm` ("files" | "network") now. */
    may(doc, perm) {
      if (perm === "network") return false;
      if (perm !== "files" || !doc) return false;
      const set = choice(doc);
      if (set && typeof set.files === "boolean") return set.files;
      // (the page's own record of its bundled examples first: a reopen finds the workspace entry's "elsewhere" there)
      const how = read(HOST_MADE, []).includes(doc) ? "host" : made.get(doc);
      return how === "person" || how === "host";
    },
    /** The person's own choice for `doc` (the page's handlers, only for an isTrusted click): in effect at once, kept,
     * and told.  Returns whether it was kept in this browser's storage (false: it holds in this page only, the
     * caller says so). */
    set(doc, perm, on) {
      if (perm !== "files" || !doc) return true;
      unkept.set(doc, { files: !!on }); // (in effect first, whatever storage does)
      const all = explicit();
      delete all[doc];
      all[doc] = { files: !!on }; // (the latest choice last: the oldest allows go first)
      const allows = Object.keys(all).filter((k) => all[k]?.files !== false);
      for (const k of allows.slice(0, Math.max(0, allows.length - ALLOWS_KEPT))) delete all[k];
      const denials = Object.keys(all).length - Math.min(allows.length, ALLOWS_KEPT);
      let kept = denials <= DENIALS_KEPT || on;
      if (!kept) delete all[doc];
      kept = write(KEY, all) && kept;
      if (kept) unkept.delete(doc);
      tell(doc);
      return kept;
    },
    /** A scoped grant for `doc` (the Permissions panel's or, from phase 2, a prompt's: a trusted click only): `kind`
     * "write" | "read" | "net", `scope` a folder or host, `once` for this session only. {ok} or {ok: false, why}:
     * "scope" (not a canonical scope), "cap" (the kind's GRANT_CAPS.perKind, stored and once together, is full, or the
     * page's session entries are: nothing widens), "storage" (couldn't be kept: nothing changed). It removes the
     * scope's denials; stored, it replaces a once entry; once, when already stored, it changes nothing. */
    grant(doc, kind, scope, { once = false } = {}) {
      const s = canonicalScope(kind, scope);
      if (!doc || !GRANT_KINDS.includes(kind) || s === null) return { ok: false, why: "scope" };
      const e = stored().docs[doc] ?? {}, ss = session.get(doc);
      const storedHas = (e[kind] ?? []).includes(s);
      const have = new Set([...(e[kind] ?? []), ...(ss?.[kind] ?? [])]);
      if (!have.has(s) && have.size >= GRANT_CAPS.perKind) return { ok: false, why: "cap" };
      if (once && !storedHas && !ss && session.size >= GRANT_CAPS.sessionDocs) return { ok: false, why: "cap" };
      const ok = commit(doc, (d) => {
        const before = (d.denied ?? []).length;
        d.denied = (d.denied ?? []).filter((x) => !(x[0] === kind && x[1] === s));
        let changed = d.denied.length !== before;
        if (!once && !(d[kind] ?? []).includes(s)) { d[kind] = [...(d[kind] ?? []), s]; changed = true; }
        return changed;
      });
      if (!ok) return { ok: false, why: "storage" };
      dropSessionDenial(ss, key(kind, s));
      if (once && !storedHas) sess(doc, true)[kind].add(s);
      if (!once) ss?.[kind].delete(s);
      prune(doc);
      tell(doc);
      return { ok: true };
    },
    /** Remove a scope's grant, stored and once (the Permissions panel's Remove). False if the stored record couldn't be
     * written (then nothing changed). */
    revoke(doc, kind, scope) {
      const s = canonicalScope(kind, scope);
      if (!doc || !GRANT_KINDS.includes(kind) || s === null) return false;
      const ok = commit(doc, (d) => { const n = (d[kind] ?? []).length; d[kind] = (d[kind] ?? []).filter((x) => x !== s); return d[kind].length !== n; });
      if (!ok) return false;
      session.get(doc)?.[kind].delete(s);
      prune(doc);
      tell(doc);
      return true;
    },
    /** Remember "Don't allow" for a scope, for this session or `stored`: it removes the scope's grants, stored and once.
     * Bounded, the oldest evicted; a repeated denial counts as fresh. False if it couldn't be recorded (the stored record
     * couldn't be written, or the page's session entries are full): then nothing changed. */
    deny(doc, kind, scope, { stored: keep = false } = {}) {
      const s = canonicalScope(kind, scope);
      if (!doc || !GRANT_KINDS.includes(kind) || s === null) return false;
      const ss0 = session.get(doc);
      if (!keep && !ss0 && session.size >= GRANT_CAPS.sessionDocs) return false;
      const ok = commit(doc, (d, r) => {
        const n = (d[kind] ?? []).length;
        d[kind] = (d[kind] ?? []).filter((x) => x !== s);
        let changed = d[kind].length !== n;
        if (keep) { d.denied = [...(d.denied ?? []).filter((x) => !(x[0] === kind && x[1] === s)), [kind, s, ++r.seq]]; changed = true; }
        return changed;
      });
      if (!ok) return false;
      ss0?.[kind].delete(s);
      if (!keep) {
        const ss = sess(doc, true), k = key(kind, s);
        dropSessionDenial(ss, k); // (a repeated denial: removed, then added again as the newest)
        ss.denied.set(k, ++sessionSeq);
        sessionDenials++;
        while (ss.denied.size > GRANT_CAPS.sessionDenialsPerDoc) { ss.denied.delete(ss.denied.keys().next().value); sessionDenials--; }
        while (sessionDenials > GRANT_CAPS.sessionDenialsPage) {
          let oldest = null;
          for (const [d, x] of session) for (const [k2, q] of x.denied) { if (!oldest || q < oldest[2]) oldest = [d, k2, q]; break; }
          session.get(oldest[0]).denied.delete(oldest[1]);
          sessionDenials--;
          prune(oldest[0]);
        }
      }
      prune(doc);
      tell(doc);
      return true;
    },
    /** Forget `doc`'s remembered denials, stored and session (the Permissions panel's Forget). */
    forgetDenials(doc) {
      const ok = commit(doc, (d) => { const n = (d.denied ?? []).length; d.denied = []; return n > 0; });
      if (!ok) return false;
      const ss = session.get(doc);
      if (ss) { sessionDenials -= ss.denied.size; ss.denied.clear(); }
      prune(doc);
      tell(doc);
      return true;
    },
    /** The end of `doc`'s session (its interpreter restarted, the document closed): its "once" grants and session
     * denials go. */
    endSession(doc) {
      const ss = session.get(doc);
      if (!ss) return;
      sessionDenials -= ss.denied.size;
      session.delete(doc);
      tell(doc);
    },
    /** `doc`'s scoped grants, read-only: { write, read, net: { stored: [...], once: [...] }, denied: { stored, session } }.
     * Recorded only, in this phase: nothing enforces them yet. */
    grants(doc) {
      const e = (doc && stored().docs[doc]) || {}, ss = session.get(doc);
      const out = {};
      for (const k of GRANT_KINDS) out[k] = { stored: [...(e[k] ?? [])], once: [...(ss?.[k] ?? [])] };
      out.denied = { stored: (e.denied ?? []).map((x) => [x[0], x[1]]), session: [...(ss?.denied.keys() ?? [])].map((k) => k.split("\u0000")) };
      return out;
    },
    /** (the tests': how many documents have session entries, and how many session denials the page holds) */
    sessionCounts() { return { docs: session.size, denials: sessionDenials }; },
    /** Told when `doc`'s permissions may have changed. */
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    /** The record, read-only (the tests', and U11's adapter's): what it decides for `doc` now. */
    record(doc) {
      const set = choice(doc) ?? null;
      return { doc, provenance: read(HOST_MADE, []).includes(doc) ? "host" : made.get(doc) ?? "unknown", explicit: set, files: api.may(doc, "files"), network: false, grants: api.grants(doc) };
    },
  };
  return api;
}
/** A document the page made from its own bundled examples (the first visit's Welcome, the Examples dialog's): its code
 * is Sagebrush's, so it may change files as the person's own notebooks may. */
export function hostMade(id) {
  const l = read(HOST_MADE, []);
  if (!l.includes(id)) write(HOST_MADE, [...l, id].slice(-200));
}
