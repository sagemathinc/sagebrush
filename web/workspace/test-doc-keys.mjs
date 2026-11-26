// ci: web-runner order=357 runner=bun chrome
// A page's notebook keys under end-to-end encryption (web/workspace/doc-keys.ts, e2e/doc-cek.ts), in headless Chromium
// with its real WebCrypto, against fixture epochs and a fixture declaration store: a document's first patch mints and
// declares one generation (once, however many sealings ask at the same time), which another device of the account
// opens from the declaration alone; the index asked once per chain head; a new epoch, or a retired generation, mints
// anew while older patches still open; a declaration race settles on the index's answer, and one refused as stale is
// minted again once; a wrapped key moved to another place, edited or cut short is refused; and a failure caches
// nothing.
//   CHROME=google-chrome bun web/workspace/test-doc-keys.mjs
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browser } from "../agents/a14-cases.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };
const J = (v) => JSON.stringify(v);

const dir = mkdtempSync(join(tmpdir(), "sb-doc-keys-"));
const entry = join(dir, "entry.ts");
writeFileSync(entry, [
  `export * as K from ${J(join(here, "doc-keys.ts"))};`,
  `export * as S from ${J(join(here, "doc-seal.ts"))};`,
  `export * as C from ${J(join(here, "e2e", "doc-cek.ts"))};`,
  `export * as e2e from ${J(join(here, "e2e", "index.ts"))};`,
].join("\n"));
const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });
rmSync(dir, { recursive: true, force: true });
if (!built.success) throw new Error("doc-keys didn't build: " + built.logs.join("\n"));
const js = await built.outputs[0].text();
// (the page: an account's epochs (each epoch's secret a fill byte), and one declaration store the account's devices
//  share, counting every call; `race` makes the next declare answer another device's generation first, `failOnce`
//  rejects the next declare, `retired` lists generations the store no longer answers as current)
const html = `<!doctype html><script type="module">import * as m from "/s.js"; Object.assign(window, m);
window.code = async (f) => { try { await f(); return "ok"; } catch (e) { return e?.code ?? String(e?.message ?? e); } };
window.ACCT = "e2e-acct-1";
window.store = () => {
  const decls = [], calls = { current: 0, exact: 0, declare: 0 }, s = { decls, calls, retired: new Set(), race: null, failOnce: false, stale: 0, onStale: null };
  const key = (d) => d.document + "/" + d.cekId + "/" + d.keyEpoch;
  s.api = {
    current: async (doc, head) => { calls.current++; for (let i = decls.length - 1; i >= 0; i--) if (decls[i].document === doc && !s.retired.has(key(decls[i]))) return decls[i]; return null; },
    exact: async (doc, cekId, keyEpoch) => { calls.exact++; return decls.find((d) => d.document === doc && d.cekId === cekId && d.keyEpoch === keyEpoch) ?? null; },
    declare: async (d) => {
      calls.declare++;
      await new Promise((r) => setTimeout(r, 5));
      if (s.failOnce) { s.failOnce = false; throw new Error("offline"); }
      if (s.stale > 0) { s.stale--; s.onStale?.(); throw Object.assign(new Error("stale head"), { code: "stale" }); }
      if (s.race) { decls.push(s.race); s.race = null; return decls[decls.length - 1]; }
      decls.push(d); return d;
    },
  };
  return s;
};
window.account = (fills, account = ACCT) => {
  const epochs = { head: "h1", currentEpoch: 1, missing: new Set() };
  const keys = new Map();
  epochs.api = {
    account,
    chain: async () => ({ head: epochs.head, currentEpoch: epochs.currentEpoch }),
    epochKeys: async (n) => {
      if (epochs.missing.has(n) || !(n in fills)) return null;
      if (!keys.has(n)) keys.set(n, await e2e.deriveEpochKeys(new Uint8Array(32).fill(fills[n]), account, n));
      return keys.get(n);
    },
  };
  return epochs;
};
window.W = (doc, cseq) => ({ doc, epoch: 1, client: "c7xq", cseq, id: "000000173246640" + String(cseq).padStart(4, "0") + "_c7xq", parents: [] });
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

  // ---- K-1: the first patch mints and declares one generation; another device opens it from the declaration alone
  {
    const r = await P.ev(`(async () => {
      const st = store(), a = account(${J(FILLS)}), b = account(${J(FILLS)});
      const pa = K.docKeys({ epochs: a.api, declarations: st.api }), pb = K.docKeys({ epochs: b.api, declarations: st.api });
      const s = await S.sealSlice(pa, W(${J(DOC)}, 1), new TextEncoder().encode('{"x":1}'));
      const d = st.decls[0], pre = S.readPrefix(s);
      const opened = new TextDecoder().decode(await S.openSlice(pb, W(${J(DOC)}, 1), s));
      return { declares: st.calls.declare, n: st.decls.length, doc: d.document, epoch: d.keyEpoch, head: d.head, wrapped: d.wrappedCek.length,
        idForm: /^[0-9a-f]{32}$/.test(d.cekId), named: pre.cekId === d.cekId && pre.keyEpoch === 1, opened, account: pa.account };
    })()`);
    ok(r.declares === 1 && r.n === 1 && r.doc === DOC && r.epoch === 1 && r.head === "h1" && r.wrapped === 60 && r.idForm, "K-1: a document's first sealing mints one generation (a random 128-bit id) under the current epoch, declared once with its 60-byte wrapped key at the current head", r);
    ok(r.named && r.opened === '{"x":1}' && r.account === "e2e-acct-1", "K-1: the slice names that generation, and another device of the account (the same epochs, its own provider) opens it from the declaration alone", r);
  }

  // ---- K-2: sealings that ask at the same time mint once; the index asked once per head
  {
    const r = await P.ev(`(async () => {
      const st = store(), a = account(${J(FILLS)}), p = K.docKeys({ epochs: a.api, declarations: st.api });
      const gens = await Promise.all([1, 2, 3, 4, 5].map(() => p.current(${J(DOC)})));
      const same = gens.every((g) => g.cekId === gens[0].cekId && g.cek === gens[0].cek);
      const after5 = { ...st.calls };
      await p.current(${J(DOC)}); await p.current(${J(DOC)});
      const sameHead = { ...st.calls };
      a.head = "h2"; const g2 = await p.current(${J(DOC)});
      await p.current(${J(DOC2)});
      return { same, after5, sameHead, newHead: { ...st.calls }, kept: g2.cekId === gens[0].cekId, n: st.decls.length };
    })()`);
    ok(r.same && r.after5.declare === 1 && r.after5.current === 1, "K-2: five sealings asking at once get one generation: the index asked once, one declaration", r);
    ok(r.sameHead.current === 1 && r.sameHead.declare === 1, "K-2: at the same chain head the index isn't asked again", r);
    ok(r.newHead.current === 3 && r.kept && r.n === 2, "K-2: a new head asks the index again and keeps the declared generation of the same epoch (no mint); another document gets its own", r);
  }

  // ---- K-3: a new epoch mints anew; patches of the old generation still open
  {
    const r = await P.ev(`(async () => {
      const st = store(), a = account(${J(FILLS)}), p = K.docKeys({ epochs: a.api, declarations: st.api });
      const old = await S.sealSlice(p, W(${J(DOC)}, 1), new Uint8Array([1]));
      a.head = "h-removal"; a.currentEpoch = 2;
      const neu = await S.sealSlice(p, W(${J(DOC)}, 2), new Uint8Array([2]));
      const b = account(${J(FILLS)}), q = K.docKeys({ epochs: b.api, declarations: st.api });
      return { gens: st.decls.map((d) => [d.keyEpoch, d.head]), pOld: S.readPrefix(old).keyEpoch, pNew: S.readPrefix(neu).keyEpoch,
        o1: Array.from(await S.openSlice(q, W(${J(DOC)}, 1), old)), o2: Array.from(await S.openSlice(q, W(${J(DOC)}, 2), neu)) };
    })()`);
    ok(J(r.gens) === J([[1, "h1"], [2, "h-removal"]]) && r.pOld === 1 && r.pNew === 2, "K-3: once an epoch begins (as a removal begins one), the next sealing mints a generation of the new epoch, declared at the new head", r);
    ok(J(r.o1) === J([1]) && J(r.o2) === J([2]), "K-3: patches of both generations open, each under its own epoch's keys", r);
  }

  // ---- K-4: a generation retired at a head isn't sealed under from it on
  {
    const r = await P.ev(`(async () => {
      const st = store(), a = account(${J(FILLS)}), p = K.docKeys({ epochs: a.api, declarations: st.api });
      const g1 = await p.current(${J(DOC)});
      st.retired.add(${J(DOC)} + "/" + g1.cekId + "/1"); a.head = "h2";
      const g2 = await p.current(${J(DOC)});
      return { differ: g1.cekId !== g2.cekId, epoch: g2.keyEpoch, n: st.decls.length, head: st.decls[1]?.head };
    })()`);
    ok(r.differ && r.epoch === 1 && r.n === 2 && r.head === "h2", "K-4: when the index no longer answers a generation as current at the new head (retired), a new one is minted and declared there", r);
  }

  // ---- K-5: a declaration race settles on the index's answer
  {
    const r = await P.ev(`(async () => {
      const st = store(), a = account(${J(FILLS)}), b = account(${J(FILLS)});
      const pa = K.docKeys({ epochs: a.api, declarations: st.api });
      // (device b's own generation, declared first: the store answers it to a's declaration)
      const keysB = await b.api.epochKeys(1), m = await C.mintDocCek(keysB, { account: ACCT, document: ${J(DOC)}, cekId: "b-gen", keyEpoch: 1 });
      st.race = { document: ${J(DOC)}, cekId: "b-gen", keyEpoch: 1, wrappedCek: m.wrapped, head: "h1" };
      const s = await S.sealSlice(pa, W(${J(DOC)}, 1), new Uint8Array([7]));
      const pb = K.docKeys({ epochs: b.api, declarations: st.api });
      const later = await pa.current(${J(DOC)});
      return { named: S.readPrefix(s).cekId, opened: Array.from(await S.openSlice(pb, W(${J(DOC)}, 1), s)), later: later.cekId };
    })()`);
    ok(r.named === "b-gen" && J(r.opened) === J([7]) && r.later === "b-gen", "K-5: when another device's declaration came first, its generation is the one sealed under (unwrapped from its declaration), and it stays current", r);
  }

  // ---- K-6: exact lookups only
  {
    const r = await P.ev(`(async () => {
      const st = store(), a = account(${J(FILLS)}), p = K.docKeys({ epochs: a.api, declarations: st.api });
      const g = await p.current(${J(DOC)});
      const out = { unknown: await p.find(${J(DOC)}, "nope", 1), otherEpoch: await p.find(${J(DOC)}, g.cekId, 2), otherDoc: await p.find(${J(DOC2)}, g.cekId, 1) };
      const liar = K.docKeys({ epochs: a.api, declarations: { ...st.api, exact: async () => st.decls[0] } });
      out.liar = await code(() => liar.find(${J(DOC)}, "nope", 1));
      return out;
    })()`);
    ok(r.unknown === null && r.otherEpoch === null && r.otherDoc === null, "K-6: a generation the index doesn't declare for that document, id and epoch is null (never another, never the current one)", r);
    ok(/another generation/.test(r.liar), "K-6: an index answer for another generation than the one asked for is refused", r);
  }

  // ---- K-7: a wrapped key opens only for its own place, and only whole
  {
    const r = await P.ev(`(async () => {
      const a = account(${J(FILLS)}), k1 = await a.api.epochKeys(1), k2 = await a.api.epochKeys(2);
      const P0 = { account: ACCT, document: ${J(DOC)}, cekId: "g-1", keyEpoch: 1 };
      const { wrapped } = await C.mintDocCek(k1, P0), out = {};
      out.home = await code(() => C.unwrapDocCek(k1, P0, wrapped));
      out.otherDoc = await code(() => C.unwrapDocCek(k1, { ...P0, document: ${J(DOC2)} }, wrapped));
      out.otherId = await code(() => C.unwrapDocCek(k1, { ...P0, cekId: "g-2" }, wrapped));
      const edited = wrapped.slice(); edited[20] ^= 1;
      out.edited = await code(() => C.unwrapDocCek(k1, P0, edited));
      out.short = await code(() => C.unwrapDocCek(k1, P0, wrapped.slice(0, 59)));
      out.otherEpochKeys = await code(() => C.unwrapDocCek(k2, P0, wrapped));
      const other = account(${J(FILLS)}, "e2e-acct-2"), ko = await other.api.epochKeys(1);
      out.otherAccountKeys = await code(() => C.unwrapDocCek(ko, P0, wrapped));
      out.forged = await code(() => C.mintDocCek({ ...k1 }, P0));
      return out;
    })()`);
    const refused = ["otherDoc", "otherId", "edited", "short", "otherEpochKeys", "otherAccountKeys", "forged"].filter((k) => r[k] !== "bad_form");
    ok(r.home === "ok" && refused.length === 0, "K-7: a wrapped key opens for its own document, id and epoch; moved to another document or id, edited, cut short, or given another epoch's, another account's or a copied bundle of keys, it is refused (bad_form)", r);
  }

  // ---- K-8: a failure caches nothing
  {
    const r = await P.ev(`(async () => {
      const st = store(), a = account(${J(FILLS)}), p = K.docKeys({ epochs: a.api, declarations: st.api });
      st.failOnce = true;
      const first = await code(() => p.current(${J(DOC)}));
      const second = await code(() => p.current(${J(DOC)}));
      a.missing.add(1);
      const b = account(${J(FILLS)}); b.missing.add(1);
      const q = K.docKeys({ epochs: b.api, declarations: st.api });
      const noKeys = await code(() => q.find(${J(DOC)}, st.decls[0].cekId, 1));
      b.missing.delete(1);
      const back = await code(() => q.find(${J(DOC)}, st.decls[0].cekId, 1));
      return { first, second, declares: st.calls.declare, n: st.decls.length, noKeys, back };
    })()`);
    ok(r.first === "offline" && r.second === "ok" && r.declares === 2 && r.n === 1, "K-8: a declaration that fails fails the sealing, and the next asks again (nothing cached)", r);
    ok(/epoch 1's keys/.test(r.noKeys) && r.back === "ok", "K-8: a device without the generation's epoch keys refuses to open it, and opens it once it has them", r);
  }

  // ---- K-10: a declaration refused "stale" (the chain moved on before it went up) is minted again, once
  {
    const r = await P.ev(`(async () => {
      const st = store(), a = account(${J(FILLS)}), p = K.docKeys({ epochs: a.api, declarations: st.api });
      st.stale = 1; st.onStale = () => { a.head = "h-removal"; a.currentEpoch = 2; };
      const g = await p.current(${J(DOC)});
      const once = { epoch: g.keyEpoch, declares: st.calls.declare, decls: st.decls.map((d) => [d.keyEpoch, d.head]) };
      const st2 = store(), b = account(${J(FILLS)}), q = K.docKeys({ epochs: b.api, declarations: st2.api });
      st2.stale = 2;
      const twice = await code(() => q.current(${J(DOC)}));
      return { once, twice, declares2: st2.calls.declare };
    })()`);
    ok(r.once.epoch === 2 && r.once.declares === 2 && J(r.once.decls) === J([[2, "h-removal"]]), "K-10: a declaration refused stale is minted again under the chain read afresh (the new epoch, declared at the new head)", r);
    ok(r.twice === "stale" && r.declares2 === 2, "K-10: only once: a second stale refusal fails the sealing", r);
  }

  // ---- K-9: no page has keys yet
  {
    const r = await P.ev(`(async () => (await K.pageDocKeys()) === undefined)()`);
    ok(r === true, "K-9: pageDocKeys answers undefined while no account has end-to-end keys: DocSync carries patches as before");
  }
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  server.stop(true);
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
