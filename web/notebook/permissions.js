// What a document's code may do in this browser: the one host record (William, Nov 2: "it could be _safe_ to run any
// notebook in a mode where it can't mutate the filesystem", and 11:15 PM PST: "enable/disable network - enable/disable
// filesystem io. There's just two parameters"; plan-no-mutation r3, astra's CLEAR 5fe204ad). Named for what they do:
// "File writes" and "Network", never "trust" (William, Nov 6, 9:15 PM PST).
//
// Two switches (today's, unchanged in what they decide):
//   files    may change the person's files. On for a notebook the person made in this site's own UI (its workspace
//            entry's `made: "person"`, which the host keeps and never reads from the document, a file or a URL) and for
//            one the page made from its own bundled examples ("host"); off for any other (a remote URL, a share link,
//            an upload, a copy of one, provenance unknown, the local server's, a disk file's). The person changes it
//            with a trusted click (the bar's "Allow changes for this notebook", the Permissions panel), kept per
//            document here, and an explicit setting beats the default, a reopen included.
//   network  may reach the network: off for every document; nothing reads it yet.
// And the scoped grants of the confinement spec (r3.1 §2, §4.1, approved by William Nov 6, 9:43 PM PST), RECORDED
// here (its phase 1a) but not yet enforced anywhere (phase 2 checks write trees, phase 3 hosts, phase 4 read trees):
//   write trees, read trees, hosts: each stored ("Allow for this notebook") or for this page's session ("Allow once");
//   denials of a scope, stored or for the session. Bounded (§4.1 Bounds): at most GRANT_CAPS.perKind of each kind,
//   stored and once together, refused past it (nothing widens at the cap); stored denials at most
//   GRANT_CAPS.storedDenials page-wide, session denials GRANT_CAPS.sessionDenialsPerDoc a document and
//   GRANT_CAPS.sessionDenialsPage in the page, the oldest evicted (an evicted denial can only bring a prompt back).
// The record's key is new ("sagebrush-grants"): the choices kept under the old key ("sagebrush-permissions") are not
// read or migrated, so a document someone allowed before asks once more (the spec's §10 phase 1; no silent widening).
// Checked where a change is made: the interpreter's file layer (web/shims/fs.ts), the page as it keeps a change
// (index.html, at the change and again as its queue writes it), the shell's mutating verbs and the true rename (U11).
// Stored in this browser by the page alone (localStorage: the interpreter, in its opaque-origin frame, can't reach it).

const KEY = "sagebrush-grants", HOST_MADE = "sagebrush-host-made";
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
// (the explicit switch choices kept: allows past ALLOWS_KEPT go, oldest first (a forgotten allow falls back to the
// default, never more than it); a "don't allow" is never dropped to make room (astra's NM-DENY-2): past DENIALS_KEPT it
// is held in this page and set() says it wasn't kept)
export const ALLOWS_KEPT = 2000, DENIALS_KEPT = 20000;
// (the scoped grants' bounds: confinement spec r3.1 §4.1)
export const GRANT_CAPS = Object.freeze({ perKind: 32, pathChars: 1024, hostChars: 253, storedDenials: 20000, sessionDenialsPerDoc: 256, sessionDenialsPage: 4096, docsKept: 2000 });
export const GRANT_KINDS = Object.freeze(["write", "read", "net"]);

/** A grant's scope in its one canonical form, or null if it isn't one: a workspace folder ("/", or "/a/b", no "." or
 * ".." segment, no empty one, no trailing "/") for write and read; an exact host ("api.example.org", lowercase, or
 * "host:port"), no wildcard, scheme, user or path, for net. */
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
    const s = scope.toLowerCase();
    const m = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/.exec(s);
    if (!m || m[1].length > GRANT_CAPS.hostChars || (m[2] !== undefined && (+m[2] < 1 || +m[2] > 65535))) return null;
    return m[2] === undefined || m[2] === "443" ? m[1] : `${m[1]}:${+m[2]}`;
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
  // (the session's grants and denials, never stored: doc -> { write, read, net: Set of scopes, denied: Map key -> seq })
  const session = new Map();
  let sessionSeq = 0, sessionDenials = 0;
  const empty = () => ({ v: 1, seq: 0, docs: {} });
  const stored = () => { const r = read(KEY, null); return r && r.v === 1 && r.docs && typeof r.docs === "object" ? r : empty(); };
  const docOf = (r, doc) => (r.docs[doc] ??= {});
  const choice = (doc) => unkept.get(doc) ?? (() => { const d = stored().docs[doc]; return d && typeof d.files === "boolean" ? { files: d.files } : undefined; })();
  const tell = (doc) => listeners.forEach((f) => f(doc));
  const sess = (doc) => { let s = session.get(doc); if (!s) session.set(doc, (s = { write: new Set(), read: new Set(), net: new Set(), denied: new Map() })); return s; };
  // (a stored record kept within its bounds: past storedDenials denials, the oldest go; a document left with nothing
  // goes; past docsKept documents holding only scoped grants and denials (no switch choice: those are set()'s, by its
  // own rules), the ones least recently changed go, which only narrows or brings a prompt back)
  const trim = (r) => {
    const docs = Object.entries(r.docs);
    const denials = docs.flatMap(([d, e]) => (e.denied ?? []).map((x) => [x[2], d, x]));
    if (denials.length > GRANT_CAPS.storedDenials) {
      denials.sort((a, b) => a[0] - b[0]);
      for (const [, d, x] of denials.slice(0, denials.length - GRANT_CAPS.storedDenials)) r.docs[d].denied = r.docs[d].denied.filter((y) => y !== x);
    }
    const bare = (e) => typeof e.files !== "boolean" && !GRANT_KINDS.some((k) => e[k]?.length) && !e.denied?.length;
    for (const [d, e] of docs) if (bare(e)) delete r.docs[d];
    const scoped = Object.entries(r.docs).filter(([, e]) => typeof e.files !== "boolean").sort((a, b) => (a[1].t ?? 0) - (b[1].t ?? 0));
    for (const [d] of scoped.slice(0, Math.max(0, scoped.length - GRANT_CAPS.docsKept))) delete r.docs[d];
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
    /** The person's own choice of a switch for `doc` (the page's handlers, only for an isTrusted click): in effect at
     * once, kept, and told.  Returns whether it was kept in this browser's storage (false: it holds in this page only,
     * the caller says so). */
    set(doc, perm, on) {
      if (perm !== "files" || !doc) return true;
      unkept.set(doc, { files: !!on }); // (in effect first, whatever storage does)
      const r = stored();
      const e = docOf(r, doc);
      e.files = !!on;
      e.t = ++r.seq;
      // (allows past ALLOWS_KEPT go, oldest first; a "don't allow" past DENIALS_KEPT isn't kept: held in this page)
      const entries = Object.entries(r.docs);
      const allows = entries.filter(([, x]) => x.files === true).sort((a, b) => (a[1].t ?? 0) - (b[1].t ?? 0));
      for (const [d] of allows.slice(0, Math.max(0, allows.length - ALLOWS_KEPT))) { if (r.docs[d].files === true) delete r.docs[d].files; }
      let kept = true;
      if (!on && entries.filter(([, x]) => x.files === false).length > DENIALS_KEPT) { delete e.files; kept = false; }
      trim(r);
      kept = write(KEY, r) && kept;
      if (kept) unkept.delete(doc);
      tell(doc);
      return kept;
    },
    /** A scoped grant for `doc` (the Permissions panel's or, from phase 2, a prompt's: a trusted click only): `kind`
     * "write" | "read" | "net", `scope` a folder or host, `once` for this session only. {ok} or {ok: false, why}:
     * "scope" (not a canonical scope), "cap" (the kind's GRANT_CAPS.perKind, stored and once together, is full: nothing
     * widens; the person removes one first), "storage" (couldn't be kept; nothing changed). A grant forgets the same
     * scope's denials. */
    grant(doc, kind, scope, { once = false } = {}) {
      const s = canonicalScope(kind, scope);
      if (!doc || !GRANT_KINDS.includes(kind) || s === null) return { ok: false, why: "scope" };
      const r = stored(), e = r.docs[doc] ?? {}, ss = session.get(doc);
      const have = new Set([...(e[kind] ?? []), ...(ss?.[kind] ?? [])]);
      if (!have.has(s) && have.size >= GRANT_CAPS.perKind) return { ok: false, why: "cap" };
      if (once) sess(doc)[kind].add(s);
      else {
        const d = docOf(r, doc);
        d[kind] = [...new Set([...(d[kind] ?? []), s])];
        d.denied = (d.denied ?? []).filter((x) => !(x[0] === kind && x[1] === s));
        d.t = ++r.seq;
        trim(r);
        if (!write(KEY, r)) return { ok: false, why: "storage" };
      }
      const key = kind + "\u0000" + s;
      if (ss?.denied.delete(key)) sessionDenials--;
      tell(doc);
      return { ok: true };
    },
    /** Remove a scope's grant, stored and once (the Permissions panel's Remove). */
    revoke(doc, kind, scope) {
      const s = canonicalScope(kind, scope);
      if (!doc || !GRANT_KINDS.includes(kind) || s === null) return false;
      session.get(doc)?.[kind].delete(s);
      const r = stored(), e = r.docs[doc];
      if (e?.[kind]) { e[kind] = e[kind].filter((x) => x !== s); e.t = ++r.seq; if (!write(KEY, r)) return false; }
      tell(doc);
      return true;
    },
    /** Remember "Don't allow" for a scope: for this session, or `stored`. Bounded, the oldest evicted. */
    deny(doc, kind, scope, { stored: keep = false } = {}) {
      const s = canonicalScope(kind, scope);
      if (!doc || !GRANT_KINDS.includes(kind) || s === null) return false;
      if (keep) {
        const r = stored(), d = docOf(r, doc);
        d.denied = [...(d.denied ?? []).filter((x) => !(x[0] === kind && x[1] === s)), [kind, s, ++r.seq]];
        trim(r);
        if (!write(KEY, r)) return false;
      } else {
        const ss = sess(doc), key = kind + "\u0000" + s;
        if (!ss.denied.has(key)) sessionDenials++;
        ss.denied.set(key, ++sessionSeq);
        // (a document's, then the page's: the oldest evicted)
        while (ss.denied.size > GRANT_CAPS.sessionDenialsPerDoc) { ss.denied.delete(ss.denied.keys().next().value); sessionDenials--; }
        while (sessionDenials > GRANT_CAPS.sessionDenialsPage) {
          let oldest = null;
          for (const [d, x] of session) for (const [k, q] of x.denied) if (!oldest || q < oldest[2]) oldest = [d, k, q];
          session.get(oldest[0]).denied.delete(oldest[1]);
          sessionDenials--;
        }
      }
      tell(doc);
      return true;
    },
    /** Forget `doc`'s remembered denials, stored and session (the Permissions panel's Forget). */
    forgetDenials(doc) {
      const ss = session.get(doc);
      if (ss) { sessionDenials -= ss.denied.size; ss.denied.clear(); }
      const r = stored(), e = r.docs[doc];
      if (e?.denied?.length) { e.denied = []; if (!write(KEY, r)) return false; }
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
