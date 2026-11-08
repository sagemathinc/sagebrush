// The library files the CLI embeds lazily (P3a design note, accepted Nov 7): a second gzip blob in lib.gen.js, decoded
// the first time one of its files is read (an import), never at startup (src/lib-embed.ts). Only modules no mode's start
// imports belong here; test/lib-embed.test.ts holds the guards (a fresh start decodes it 0 times; importing one of
// its modules, once). The browser's worker needs no list: a file no start uses is a chunk group of its own
// (web/lib-chunks.mts), fetched on import already.
// (an entry ending in "/" is a package: every file under it)
export const LAZY_LIB = ["pathlib/", "glob.py", "fnmatch.py", "stat.py", "ntpath.py", "genericpath.py", "errno.py", "_os_lazy.py", "difflib.py", "shutil.py", "pyexpat.py", "xml/", "_io_text.py"];

/** Is library path `p` (relative to lib/) in pathlib's lazy blob? */
export function isLazyLib(p) {
  return LAZY_LIB.some((e) => (e.endsWith("/") ? p.startsWith(e) : p === e));
}

// The keyed family blobs beyond pathlib's (design/rill.md §6.3, daybreak2's ruling for Rill A1.1): each family is a
// blob of its own, decoded only by the first read of one of its files, so a Python or Sage start decodes none and a
// Rill start only Rill's. A family is listed here only once it has files (rill-more, rill-ggplot2, rill-dplyr and
// rill-data join as their first files land); its files are exactly those its entries name.
export const LAZY_FAMILIES = { rill: ["_rill/"] };

/** The keyed family of library path `p`, or null (pathlib's blob, isLazyLib, is the unkeyed one). */
export function familyOf(p) {
  for (const [key, entries] of Object.entries(LAZY_FAMILIES)) if (entries.some((e) => (e.endsWith("/") ? p.startsWith(e) : p === e))) return key;
  return null;
}
