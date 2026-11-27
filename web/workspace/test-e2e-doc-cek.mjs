// ci: web-runner order=359 runner=bun chrome
// A document key generation's wrapped content key (e2e/doc-cek.ts; design e2e-encryption.md §3.1 and notes
// e2e-doc-key-declarations r2), in headless Chromium with its real WebCrypto: a wrapped key opens only for its own
// account, document, cekId and epoch, under that epoch's keys, and only whole (K-7, moved here with the file from the
// document keys' suite).
//   CHROME=google-chrome bun web/workspace/test-e2e-doc-cek.mjs
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browser } from "../agents/a14-cases.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };
const J = (v) => JSON.stringify(v);

const dir = mkdtempSync(join(tmpdir(), "sb-doc-cek-"));
const entry = join(dir, "entry.ts");
writeFileSync(entry, [
  `export * as C from ${J(join(here, "e2e", "doc-cek.ts"))};`,
  `export * as e2e from ${J(join(here, "e2e", "index.ts"))};`,
].join("\n"));
const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });
rmSync(dir, { recursive: true, force: true });
if (!built.success) throw new Error("doc-cek didn't build: " + built.logs.join("\n"));
const js = await built.outputs[0].text();
// (an account's epoch keys: each epoch's secret a fill byte)
const html = `<!doctype html><script type="module">import * as m from "/s.js"; Object.assign(window, m);
window.code = async (f) => { try { await f(); return "ok"; } catch (e) { return e?.code ?? String(e?.message ?? e); } };
window.ACCT = "e2e-acct-1";
window.epochKeys = (fills, account = ACCT) => async (n) => e2e.deriveEpochKeys(new Uint8Array(32).fill(fills[n]), account, n);
window.ready = true;</script>`;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => {
  if (new URL(r.url).pathname === "/s.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
  return new Response(html, { headers: { "content-type": "text/html" } });
} });
const B = await browser();
const DOC = "6f1c2a9e-0d3b-4c1e-9a7f-2b8d4e6f0a11", DOC2 = "6f1c2a9e-0d3b-4c1e-9a7f-2b8d4e6f0a12";
const FILLS = { 1: 0x11, 2: 0x22 };
try {
  const P = await B.tab();
  { const n = P.loads; await P.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` }); for (const t = Date.now(); P.loads === n && Date.now() - t < 10000; ) await new Promise((r) => setTimeout(r, 50)); await P.until(`window.ready === true`, 10000); }
  console.log(`# in ${await P.ev(`navigator.userAgent`)}`);

  // ---- K-7: a wrapped key opens only for its own place, and only whole
  {
    const r = await P.ev(`(async () => {
      const keysOf = epochKeys(${J(FILLS)}), k1 = await keysOf(1), k2 = await keysOf(2);
      const P0 = { account: ACCT, document: ${J(DOC)}, cekId: "g-1", keyEpoch: 1 };
      const { wrapped } = await C.mintDocCek(k1, P0), out = {};
      out.length = wrapped.length;
      out.home = await code(() => C.unwrapDocCek(k1, P0, wrapped));
      out.otherDoc = await code(() => C.unwrapDocCek(k1, { ...P0, document: ${J(DOC2)} }, wrapped));
      out.otherId = await code(() => C.unwrapDocCek(k1, { ...P0, cekId: "g-2" }, wrapped));
      out.otherAccountPlace = await code(() => C.unwrapDocCek(k1, { ...P0, account: "e2e-acct-2" }, wrapped));
      const edited = wrapped.slice(); edited[20] ^= 1;
      out.edited = await code(() => C.unwrapDocCek(k1, P0, edited));
      out.short = await code(() => C.unwrapDocCek(k1, P0, wrapped.slice(0, 59)));
      out.otherEpochKeys = await code(() => C.unwrapDocCek(k2, P0, wrapped));
      const ko = await epochKeys(${J(FILLS)}, "e2e-acct-2")(1);
      out.otherAccountKeys = await code(() => C.unwrapDocCek(ko, P0, wrapped));
      out.forged = await code(() => C.mintDocCek({ ...k1 }, P0));
      return out;
    })()`);
    const refused = ["otherDoc", "otherId", "otherAccountPlace", "edited", "short", "otherEpochKeys", "otherAccountKeys", "forged"].filter((k) => r[k] !== "bad_form");
    ok(r.home === "ok" && r.length === 60 && refused.length === 0, "K-7: a wrapped key (60 bytes) opens for its own document, id and epoch; moved to another document, id or account, edited, cut short, or given another epoch's, another account's or a copied bundle of keys, it is refused (bad_form)", r);
  }

  // ---- K-7b: two wraps of one place differ (a random nonce and key), and each opens to its own key
  {
    const r = await P.ev(`(async () => {
      const k1 = await epochKeys(${J(FILLS)})(1), P0 = { account: ACCT, document: ${J(DOC)}, cekId: "g-1", keyEpoch: 1 };
      const a = await C.mintDocCek(k1, P0), b = await C.mintDocCek(k1, P0);
      // (a CEK is an HKDF key: compared by a key each derives with the same inputs, used once on the same bytes)
      const iv = new Uint8Array(12), msg = new TextEncoder().encode("x");
      const enc = async (k) => {
        const d = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("test") }, k, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
        return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, d, msg)).join(",");
      };
      const oa = await C.unwrapDocCek(k1, P0, a.wrapped), ob = await C.unwrapDocCek(k1, P0, b.wrapped);
      return { differ: a.wrapped.join(",") !== b.wrapped.join(","), sameA: (await enc(a.cek)) === (await enc(oa)), sameB: (await enc(b.cek)) === (await enc(ob)), distinct: (await enc(oa)) !== (await enc(ob)) };
    })()`);
    ok(r.differ && r.sameA && r.sameB && r.distinct, "K-7b: two generations of one place wrap differently, and each wrap opens to exactly its own key", r);
  }
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  server.stop(true);
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
