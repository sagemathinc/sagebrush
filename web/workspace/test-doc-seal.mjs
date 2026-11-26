// ci: web-runner order=356 runner=bun chrome
// A notebook's patches on the wire under end-to-end encryption (web/workspace/doc-seal.ts), in headless Chromium with
// its real WebCrypto, against fixture key generations: the slice's prefix byte for byte, every malformed prefix
// refused before any key is looked up, exactly the named generation looked up (never another, never the current one
// by default), an edited prefix or a patch moved to another place refused, and the whole slice bounded by the
// protocol's patch limit at the exact edge, with the longest key generation id.
//   CHROME=google-chrome bun web/workspace/test-doc-seal.mjs
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browser } from "../agents/a14-cases.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };
const J = (v) => JSON.stringify(v);

const dir = mkdtempSync(join(tmpdir(), "sb-doc-seal-"));
const entry = join(dir, "entry.ts");
writeFileSync(entry, [
  `export * as S from ${J(join(here, "doc-seal.ts"))};`,
  `export * as e2e from ${J(join(here, "e2e", "index.ts"))};`,
  `export { LIMITS } from ${J(join(here, "..", "sync-protocol", "protocol.ts"))};`,
].join("\n"));
const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });
rmSync(dir, { recursive: true, force: true });
if (!built.success) throw new Error("doc-seal didn't build: " + built.logs.join("\n"));
const js = await built.outputs[0].text();
// (the page: a fixture key provider over named generations, counting every lookup)
const html = `<!doctype html><script type="module">import * as m from "/s.js"; Object.assign(window, m);
window.hx = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
window.code = async (f) => { try { await f(); return "ok"; } catch (e) { return e?.code ?? String(e?.message ?? e); } };
window.provider = async (gens, current) => {
  const keys = new Map(), calls = { current: 0, find: [] };
  for (const g of gens) keys.set(g.doc + "\\u0000" + g.cekId + "\\u0000" + g.keyEpoch, await e2e.importCek(new Uint8Array(32).fill(g.fill)));
  return { calls, p: {
    account: "e2e-acct-1",
    current: async (doc) => { calls.current++; const g = gens[current]; return { cekId: g.cekId, keyEpoch: g.keyEpoch, cek: keys.get(g.doc + "\\u0000" + g.cekId + "\\u0000" + g.keyEpoch) }; },
    find: async (doc, cekId, keyEpoch) => { calls.find.push([doc, cekId, keyEpoch]); return keys.get(doc + "\\u0000" + cekId + "\\u0000" + keyEpoch) ?? null; },
  } };
};
window.ready = true;</script>`;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => {
  if (new URL(r.url).pathname === "/s.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
  return new Response(html, { headers: { "content-type": "text/html" } });
} });
const B = await browser();
const DOC = "6f1c2a9e-0d3b-4c1e-9a7f-2b8d4e6f0a11";
const W = { doc: DOC, epoch: 2, client: "c7xq", cseq: 41, id: "0000001732466400000_c7xq", parents: ["0000001732466300000_c7xq"] };
const GENS = [{ doc: DOC, cekId: "k-1", keyEpoch: 5, fill: 0x11 }, { doc: DOC, cekId: "k-2", keyEpoch: 5, fill: 0x22 }, { doc: DOC, cekId: "k-1", keyEpoch: 6, fill: 0x33 }];
try {
  const P = await B.tab();
  { const n = P.loads; await P.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` }); for (const t = Date.now(); P.loads === n && Date.now() - t < 10000; ) await new Promise((r) => setTimeout(r, 50)); await P.until(`window.ready === true`, 10000); }
  console.log(`# in ${await P.ev(`navigator.userAgent`)}`);

  // ---- D-1: the slice's layout, and a round trip
  {
    const r = await P.ev(`(async () => {
      const { p, calls } = await provider(${J(GENS)}, 0), pay = new TextEncoder().encode('{"x":1}');
      const s = await S.sealSlice(p, ${J(W)}, pay);
      const back = new TextDecoder().decode(await S.openSlice(p, ${J(W)}, s));
      // (the rest, after the prefix, opens with the payload helper itself, for the same place and generation)
      const rest = await e2e.openPatch(await e2e.importCek(new Uint8Array(32).fill(0x11)), { account: "e2e-acct-1", document: ${J(DOC)}, documentEpoch: 2, cekId: "k-1", keyEpoch: 5, client: "c7xq", cseq: 41, patchId: ${J(W.id)}, parents: ${J(W.parents)} }, s.subarray(1 + 4 + 3 + 8));
      return { head: hx(s.subarray(0, 16)), len: s.length, back, rest: new TextDecoder().decode(rest), calls: { current: calls.current, find: calls.find } };
    })()`);
    ok(r.head === "01" + "00000003" + Buffer.from("k-1").toString("hex") + "0000000000000005", "D-1: a slice starts 0x01, the key generation's id as a u32 length and its bytes, the key epoch as a u64", r.head);
    ok(r.len === 16 + 32 + 7 + 16 && r.rest === '{"x":1}', "D-1: then the payload helper's sealing (seal id and one chunk), which opens on its own for the same place and generation", [r.len, r.rest]);
    ok(r.back === '{"x":1}' && r.calls.current === 1 && J(r.calls.find) === J([[DOC, "k-1", 5]]), "D-1: sealing asks for the current generation once; opening looks up exactly the generation the slice names, once", r.calls);
  }

  // ---- D-2: every malformed prefix refused before any key is looked up
  {
    const r = await P.ev(`(async () => {
      const { p, calls } = await provider(${J(GENS)}, 0), good = await S.sealSlice(p, ${J(W)}, new Uint8Array(3));
      const before = calls.find.length, cases = {};
      const withLen = (n, bytes) => { const b = new Uint8Array(1 + 4 + bytes.length + 8 + 48); b[0] = 1; new DataView(b.buffer).setUint32(1, n); b.set(bytes, 5); return b; };
      const epochOf = (big) => { const b = good.slice(); new DataView(b.buffer).setBigUint64(1 + 4 + 3, big); return b; };
      const fmt = good.slice(); fmt[0] = 2;
      cases["format 0x02"] = fmt;
      cases["format 0x00"] = (() => { const b = good.slice(); b[0] = 0; return b; })();
      cases["empty"] = new Uint8Array(0);
      for (const n of [1, 4, 7, 15]) cases["cut to " + n] = good.slice(0, n);
      cases["id length 0"] = withLen(0, new Uint8Array(0));
      cases["id length 257"] = withLen(257, new Uint8Array(257).fill(0x61));
      cases["id length past the slice"] = (() => { const b = good.slice(0, 20); new DataView(b.buffer).setUint32(1, 4000); return b; })();
      cases["id not UTF-8 (0xff)"] = withLen(1, new Uint8Array([0xff]));
      cases["id overlong UTF-8 (C0 AF)"] = withLen(2, new Uint8Array([0xc0, 0xaf]));
      cases["id a lone surrogate (ED A0 80)"] = withLen(3, new Uint8Array([0xed, 0xa0, 0x80]));
      cases["id with NUL"] = withLen(3, new Uint8Array([0x6b, 0, 0x31]));
      // (a leading byte order mark: a decoder drops it, so "EF BB BF 6B" would read as "k": not the id's one encoding)
      cases["id with a leading BOM (EF BB BF 6B)"] = withLen(4, new Uint8Array([0xef, 0xbb, 0xbf, 0x6b]));
      cases["key epoch 2^53"] = epochOf(2n ** 53n);
      cases["key epoch 2^64 - 1"] = epochOf(2n ** 64n - 1n);
      const out = {};
      for (const [k, v] of Object.entries(cases)) out[k] = await code(() => S.openSlice(p, ${J(W)}, v));
      out["2^53 - 1 is read exactly (no rounding)"] = S.readPrefix(epochOf(2n ** 53n - 1n)).keyEpoch === Number.MAX_SAFE_INTEGER;
      return { out, finds: calls.find.length - before };
    })()`);
    const { ["2^53 - 1 is read exactly (no rounding)"]: exact, ...out } = r.out;
    const wrong = Object.entries(out).filter(([, v]) => v !== "bad_form");
    ok(Object.keys(out).length === 17 && wrong.length === 0 && r.finds === 0, `D-2: ${Object.keys(out).length} malformed prefixes are each refused (bad_form) before any key lookup (0 finds): another format, empty or cut short, an id of length 0, 257 or past the slice, an id that isn't well-formed UTF-8, holds NUL or starts with a byte order mark (not its one encoding), a key epoch past 2^53 - 1`, { wrong, finds: r.finds });
    ok(exact === true, "D-2: a key epoch of exactly 2^53 - 1 is read as itself (a BigInt bound, no lossy conversion)");
  }

  // ---- D-3: exactly the named generation, never another, never the current by default, never a trial
  {
    const r = await P.ev(`(async () => {
      const a = await provider(${J(GENS)}, 2), s = await S.sealSlice(a.p, ${J(W)}, new Uint8Array(5));
      const only = await provider(${J(GENS.slice(0, 2))}, 0);
      const unlisted = await code(() => S.openSlice(only.p, ${J(W)}, s));
      return { prefix: S.readPrefix(s), unlisted, finds: only.calls.find, current: only.calls.current };
    })()`);
    ok(J(r.prefix.cekId) === J("k-1") && r.prefix.keyEpoch === 6, "D-3: a slice names the generation it was sealed under (here k-1 at key epoch 6, the current one)", r.prefix);
    ok(r.unlisted === "bad_form" && J(r.finds) === J([[DOC, "k-1", 6]]) && r.current === 0, "D-3: a provider that doesn't list it refuses it (bad_form) after exactly one lookup of that tuple; the current generation is never asked for, and no other is tried", r);
  }

  // ---- D-4: an edited prefix, or a patch opened for another place, fails before it is applied
  {
    const r = await P.ev(`(async () => {
      const { p } = await provider(${J(GENS)}, 0), s = await S.sealSlice(p, ${J(W)}, new Uint8Array(5)), out = {};
      const idTo2 = s.slice(); idTo2[1 + 4 + 2] = 0x32;
      const epochTo6 = s.slice(); new DataView(epochTo6.buffer).setBigUint64(1 + 4 + 3, 6n);
      out["the id edited to another listed generation (k-2)"] = await code(() => S.openSlice(p, ${J(W)}, idTo2));
      out["the key epoch edited to another listed generation (6)"] = await code(() => S.openSlice(p, ${J(W)}, epochTo6));
      for (const [k, v] of [["epoch", 3], ["client", "c7xr"], ["cseq", 42], ["id", "0000001732466400001_c7xq"], ["doc", "6f1c2a9e-0d3b-4c1e-9a7f-2b8d4e6f0a12"]]) {
        out["opened as another " + k] = await code(() => S.openSlice(p, { ...${J(W)}, [k]: v }, s));
      }
      out["opened with other parents"] = await code(() => S.openSlice(p, { ...${J(W)}, parents: [] }, s));
      return out;
    })()`);
    const wrong = Object.entries(r).filter(([, v]) => v !== "bad_form");
    ok(Object.keys(r).length === 8 && wrong.length === 0, "D-4: a prefix edited to another listed generation (its id or its key epoch), or a slice opened for another document, epoch, client, cseq, id or parents, is refused (bad_form): the selector and the place are bound in the sealed header", wrong);
  }

  // ---- D-5: the whole slice at most the protocol's patch limit, at the exact edge, with the longest id
  {
    const long = "k".repeat(256);
    const r = await P.ev(`(async () => {
      const gens = [{ doc: ${J(DOC)}, cekId: ${J(long)}, keyEpoch: 9007199254740991, fill: 0x44 }];
      const { p, calls } = await provider(gens, 0), max = S.payloadMax(${J(long)}, 9007199254740991);
      const atMax = await S.sealSlice(p, ${J(W)}, new Uint8Array(max)).catch((e) => null);
      const len = async (f) => { try { return (await f()).length; } catch (e) { return e?.code ?? String(e); } };
      const out = { limit: LIMITS.patchBytes, max, sealMax: atMax ? atMax.length : "refused", openMax: atMax ? await len(() => S.openSlice(p, ${J(W)}, atMax)) : "refused" };
      out.sealOver = await code(() => S.sealSlice(p, ${J(W)}, new Uint8Array(max + 1)));
      const finds = calls.find.length;
      out.openOver = await code(() => S.openSlice(p, ${J(W)}, new Uint8Array(LIMITS.patchBytes + 1)));
      out.findsOver = calls.find.length - finds;
      out.shortMax = S.payloadMax("k", 1);
      return out;
    })()`);
    ok(r.max === r.limit - (1 + 4 + 256 + 8) - 32 - 16 && r.sealMax === r.limit && r.openMax === r.max, "D-5: with the longest id (256 bytes) and the largest key epoch, a payload of exactly the bound seals to a slice of exactly the protocol's limit (256 KiB), which opens", r);
    ok(r.sealOver === "limit" && r.openOver === "limit" && r.findsOver === 0, "D-5: one byte more is refused when sealing (limit), and a slice one byte over the limit is refused when opening, before any key lookup", r);
    ok(r.shortMax === r.limit - (1 + 4 + 1 + 8) - 48, "D-5: the bound is the limit less this generation's own prefix (a short id leaves more room)", r.shortMax);
  }
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  server.stop(true);
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
