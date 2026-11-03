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
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

/** The page's one record. `doc`: the document's id as the page knows it (a notebook's, "local:…", "file:…"). */
export function createPermissions() {
  const made = new Map(); // doc -> "person" | "host" | "elsewhere" (this page's knowledge of its provenance)
  const listeners = new Set();
  const explicit = () => read(KEY, {});
  return {
    /** The host, as it opens `doc`: its provenance from its own metadata (absent: unknown, which counts as elsewhere). */
    provenance(doc, how) { made.set(doc, how === "person" || how === "host" ? how : "elsewhere"); listeners.forEach((f) => f(doc)); },
    /** Whether `doc`'s code may do `perm` ("files" | "network") now. */
    may(doc, perm) {
      if (perm === "network") return false;
      if (perm !== "files" || !doc) return false;
      const set = explicit()[doc];
      if (set && typeof set.files === "boolean") return set.files;
      const how = made.get(doc) ?? (read(HOST_MADE, []).includes(doc) ? "host" : undefined);
      return how === "person" || how === "host";
    },
    /** The person's own choice for `doc` (the page's handlers, only for an isTrusted click): kept, and told. */
    set(doc, perm, on) {
      if (perm !== "files" || !doc) return;
      const all = explicit();
      all[doc] = { ...(all[doc] ?? {}), files: !!on };
      const keys = Object.keys(all);
      if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete all[k];
      write(KEY, all);
      listeners.forEach((f) => f(doc));
    },
    /** Told when `doc`'s permissions may have changed. */
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    /** The record, read-only (the tests', and U11's adapter's): what it decides for `doc` now. */
    record(doc) {
      const set = explicit()[doc] ?? null;
      return { doc, provenance: made.get(doc) ?? "unknown", explicit: set, files: this.may(doc, "files"), network: false };
    },
  };
}
/** A document the page made from its own bundled examples (the first visit's Welcome, the Examples dialog's): its code
 * is Sagebrush's, so it may change files as the person's own notebooks may. */
export function hostMade(id) {
  const l = read(HOST_MADE, []);
  if (!l.includes(id)) write(HOST_MADE, [...l, id].slice(-200));
}
