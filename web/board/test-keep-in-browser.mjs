// ci: web-runner order=200 runner=bun
// keepInBrowser (images.ts): a picture kept in this browser's store only when the write is committed. A board's copy
// relies on it for a picture it couldn't copy as a file (page.ts makeInWorkspace), so true must mean kept: a write
// that aborts or fails, no store, or bytes that aren't the name, false. IndexedDB here is a stand-in whose
// transaction commits, aborts or fails as each case sets it.
//   bun web/board/test-keep-in-browser.mjs
let mode = "commit", opens = 0;
const stored = new Map();
globalThis.indexedDB = {
  open() {
    opens++;
    const r = {};
    setTimeout(() => {
      if (mode === "noStore") { r.error = new Error("no store"); r.onerror?.(); return; }
      r.result = {
        createObjectStore() {},
        close() {},
        transaction() {
          const t = {};
          t.objectStore = () => ({
            put(b, k) {
              const q = {};
              setTimeout(() => {
                if (mode === "commit") { stored.set(k, b); q.onsuccess?.(); t.oncomplete?.(); }
                else if (mode === "abort") { q.onsuccess?.(); t.onabort?.(); }
                else { q.onerror?.(); t.onerror?.(); }
              });
              return q;
            },
          });
          return t;
        },
      };
      r.onupgradeneeded?.({ oldVersion: 0 });
      r.onsuccess?.();
    });
    return r;
  },
};
const { keepInBrowser } = await import("./images.ts");

let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const blob = (fill) => { const u = new Uint8Array(64).fill(fill); u.set(PNG); return new Blob([u], { type: "image/png" }); };
const sha = async (b) => "i" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", await b.arrayBuffer())).slice(0, 16)].map((x) => x.toString(16).padStart(2, "0")).join("");

const a = blob(1), na = await sha(a);
ok((await keepInBrowser(a, na)) === true && stored.has(na), "a committed write: true, and it is there");
mode = "abort";
const b = blob(2), nb = await sha(b);
ok((await keepInBrowser(b, nb)) === false && !stored.has(nb), "a write whose transaction aborts (its put succeeded): false");
mode = "error";
const c = blob(3), nc = await sha(c);
ok((await keepInBrowser(c, nc)) === false && !stored.has(nc), "a write that fails: false");
mode = "commit";
ok((await keepInBrowser(blob(4), na)) === false, "bytes that aren't the name's: false, nothing kept under it");
console.log(failures ? `${failures} FAILED` : "test-keep-in-browser: all passed");
process.exit(failures ? 1 : 0);
