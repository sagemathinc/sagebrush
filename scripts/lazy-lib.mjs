// The library files the CLI embeds lazily (P3a design note, accepted Nov 7): a second gzip blob in lib.gen.js, decoded
// the first time one of its files is read (an import), never at startup (src/lib-embed.ts). Only modules no mode's start
// imports belong here; test/lib-embed.test.ts holds the guards (a fresh start decodes it 0 times; importing one of
// its modules, once). The browser's worker needs no list: a file no start uses is a chunk group of its own
// (web/lib-chunks.mts), fetched on import already.
// (an entry ending in "/" is a package: every file under it)
export const LAZY_LIB = ["pathlib/", "glob.py", "fnmatch.py", "stat.py", "ntpath.py", "genericpath.py", "errno.py", "_os_lazy.py"];

/** Is library path `p` (relative to lib/) lazily embedded? */
export function isLazyLib(p) {
  return LAZY_LIB.some((e) => (e.endsWith("/") ? p.startsWith(e) : p === e));
}
