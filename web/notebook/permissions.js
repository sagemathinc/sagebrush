// What a document's code may do in this browser: the one host record (William, Nov 2: "it could be _safe_ to run any
// notebook in a mode where it can't mutate the filesystem", and 11:15 PM PST: "enable/disable network - enable/disable
// filesystem io. There's just two parameters"; plan-no-mutation r3, astra's CLEAR 5fe204ad). Two permissions:
//   files    may change the person's files. On for a notebook the person made in this site's own UI (its workspace
//            entry's `made: "person"`, which the host keeps and never reads from the document, a file or a URL) and for
//            one the page made from its own bundled examples ("host"); off for any other (a remote URL, a share link,
//            an upload, a copy of one, provenance unknown, the local server's, a disk file's). The person changes it
//            with a trusted click (the bar's "Allow changes for this notebook", ⋯ "Allow / Don't allow file changes"),
//            kept per document here, and an explicit setting beats the default, a reopen included.
//   network  may reach the network: off for every document; nothing reads it yet (there is no network path today).
// Checked where a change is made: the interpreter's file layer (web/shims/fs.ts), the page as it keeps a change
// (index.html, at the change and again as its queue writes it), the shell's mutating verbs and the true rename (U11).
// Stored in this browser by the page alone (localStorage: the interpreter, in its opaque-origin frame, can't reach it).

const KEY = "sagebrush-permissions", HOST_MADE = "sagebrush-host-made";
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
// (the explicit choices kept: allows past ALLOWS_KEPT go, oldest first (a forgotten allow falls back to the default, never
// more than it); a "don't allow" is never dropped to make room (astra's NM-DENY-2): past DENIALS_KEPT it is held in this
// page and set() says it wasn't kept)
export const ALLOWS_KEPT = 2000, DENIALS_KEPT = 20000;

/** The page's one record. `doc`: the document's id as the page knows it (a notebook's, "local:…", "file:…"). */
export function createPermissions() {
  const made = new Map(); // doc -> "person" | "host" | "elsewhere" (this page's knowledge of its provenance)
  const listeners = new Set();
  // (the choices this page couldn't keep in storage: they hold here, over what storage says, until the page closes)
  const unkept = new Map(); // doc -> { files }
  const explicit = () => read(KEY, {});
  const choice = (doc) => unkept.get(doc) ?? explicit()[doc];
  return {
    /** The host, as it opens `doc`: its provenance from its own metadata (absent: unknown, which counts as elsewhere). */
    provenance(doc, how) { made.set(doc, how === "person" || how === "host" ? how : "elsewhere"); listeners.forEach((f) => f(doc)); },
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
      listeners.forEach((f) => f(doc));
      return kept;
    },
    /** Told when `doc`'s permissions may have changed. */
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    /** The record, read-only (the tests', and U11's adapter's): what it decides for `doc` now. */
    record(doc) {
      const set = choice(doc) ?? null;
      return { doc, provenance: read(HOST_MADE, []).includes(doc) ? "host" : made.get(doc) ?? "unknown", explicit: set, files: this.may(doc, "files"), network: false };
    },
  };
}
/** A document the page made from its own bundled examples (the first visit's Welcome, the Examples dialog's): its code
 * is Sagebrush's, so it may change files as the person's own notebooks may. */
export function hostMade(id) {
  const l = read(HOST_MADE, []);
  if (!l.includes(id)) write(HOST_MADE, [...l, id].slice(-200));
}
