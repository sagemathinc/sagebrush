// The import search keeps each directory's listing while the directory's mtime stays the same (src/compile.ts, as
// CPython's FileFinder).  This count says when a listing may be out of date though no mtime moved: it advances at the
// start of every run (a notebook's request, a kernel's execute, a Terminal command) and at each change this worker
// makes to the page's files (a Terminal command's, web/shims/fs.ts, whose folders' times don't move).
export const listingEpoch = { n: 0 };
