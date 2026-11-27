// ci: web-runner order=598 runner=bun
// An arXiv paper's source, fetched (web/arxiv/source.ts; design/arxiv-proxy.md §2, §3 and §7), against a stand-in
// export.arxiv.org whose answers are built here or recorded from arXiv (web/tar/fixtures/arxiv-recorded.json), with a
// fake clock:
//   - parseArxiv: every id and URL form, versions, and the refusals; only the canonical id reaches a request URL;
//   - version pinning: the latest version found for 1 to 70 versions, at most 16 probes, starting at least 1 s apart,
//     HEAD only; a probe that fails pins an older version, never one not seen; v64 answering pins v64 ("capped");
//     v1 failing, the deadline and Cancel each stop it;
//   - the download: a tar.gz and a single gzipped .tex opened, with the main file found; a PDF-only paper, a withdrawn
//     one (arXiv's recorded answers), a 429 and a 503, a Content-Length over the cap refused before any byte is read, a
//     source past a cap refused while it streams, the deadline and Cancel mid-download, and the request's options.
//   bun web/arxiv/test-arxiv-source.mjs
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArxiv, srcUrl, absUrl, pinVersion, fetchSource, Deadline, ArxivError, PROBES_MAX, PROBE_GAP_MS, IMPORT_DEADLINE_MS } from "./source.ts";

let failures = 0, checks = 0;
const ok = (c, name, detail) => { checks++; if (!c) { failures++; console.log("FAIL " + name + (detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400))); } };
const code = async (f) => { try { await f(); return null; } catch (e) { return e instanceof ArxivError ? e.code : "other:" + String(e?.message ?? e); } };
const codeSync = (f) => { try { f(); return null; } catch (e) { return e instanceof ArxivError ? e.code : "other"; } };

// ---- parseArxiv
{
  const good = [
    ["2611.26934", "2611.26934", null], ["2611.26934v2", "2611.26934", 2], ["0704.0001", "0704.0001", null], ["1412.9999v12", "1412.9999", 12],
    ["1501.00001", "1501.00001", null], ["math/0211159", "math/0211159", null], ["math/0211159v1", "math/0211159", 1], ["math.NT/0211159v3", "math/0211159", 3],
    ["hep-th/9108001", "hep-th/9108001", null], ["cond-mat/0703999v999", "cond-mat/0703999", 999], ["arXiv:2611.26934", "2611.26934", null],
    ["https://arxiv.org/abs/2611.26934v2", "2611.26934", 2], ["arxiv.org/pdf/2611.26934v2.pdf", "2611.26934", 2], ["https://arxiv.org/pdf/2611.26934", "2611.26934", null],
    ["https://export.arxiv.org/src/math/0211159", "math/0211159", null], ["https://arxiv.org/e-print/2611.26934v1", "2611.26934", 1],
    ["https://www.arxiv.org/abs/2611.26934?context=math", "2611.26934", null], ["  2611.26934  ", "2611.26934", null],
  ];
  const bad = good.map(([s, id, v]) => [s, id, v, (() => { try { return parseArxiv(s); } catch (e) { return e.code; } })()]).filter(([, id, v, r]) => r?.id !== id || r?.version !== v);
  ok(bad.length === 0, "parseArxiv: every id and URL form, with its version", bad);
  const refused = ["", "2611.2693", "2611.269345", "1412.00001", "1501.0001", "0703.0001", "2613.00001", "2611.26934v0", "2611.26934v01", "2611.26934v1000",
    "math/0211159/../x", "../2611.26934", "/2611.26934", "notanarchive/0211159", "math/9107001", "hep-th/9012001", "math/0704001", "math/0213159", "math/021115",
    "https://example.org/abs/2611.26934", "https://arxiv.org/list/math.NT/new", "2611.26934#x", "x".repeat(300), "2611.26934 v2", "MATH/0211159"];
  const through = refused.filter((s) => codeSync(() => parseArxiv(s)) !== "address");
  ok(through.length === 0, "parseArxiv: refused: a short or long number, a month or era that doesn't exist, v0, v01 and v1000, a path, an unknown archive, another host, an over-long text", through);
  ok(srcUrl("2611.26934", 2) === "https://export.arxiv.org/src/2611.26934v2" && srcUrl("math/0211159", 1) === "https://export.arxiv.org/src/math/0211159v1"
    && absUrl("math/0211159", 3) === "https://arxiv.org/abs/math/0211159v3", "srcUrl and absUrl: the canonical id, its version");
}

// ---- a stand-in export.arxiv.org with a fake clock: `versions` exist; `flaky` versions fail their first probe
function stand({ versions = 1, flaky = [], body = null, status = 200, headers = {}, chunks = 4096, stall = false } = {}) {
  let t = 1_000_000;
  const log = [], flakySeen = new Set();
  const env = {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    fetch: async (url, init) => {
      log.push({ url, method: init.method, at: t, init });
      if (init.signal?.aborted) throw new Error("aborted");
      const m = /\/src\/(.+)v(\d+)$/.exec(url), v = m ? +m[2] : 0;
      if (init.method === "HEAD") {
        t += 50;
        if (flaky.includes(v) && !flakySeen.has(v)) { flakySeen.add(v); throw new TypeError("network"); }
        if (v >= 1 && v <= versions) return new Response(null, { status: 200 });
        throw new TypeError("network"); // (a 404 has no CORS headers: the page sees a network error)
      }
      const b = body ?? new Uint8Array(0);
      let at = 0;
      const stream = new ReadableStream({
        async pull(c) {
          if (stall) { t += IMPORT_DEADLINE_MS; await new Promise((r) => setTimeout(r, 5)); }
          if (init.signal?.aborted) { c.error(new Error("aborted")); return; }
          if (at >= b.length) { c.close(); return; }
          c.enqueue(b.slice(at, at + chunks)); at += chunks; log.pulled = at;
        },
        cancel() { log.cancelled = true; },
      });
      return new Response(stream, { status, headers });
    },
  };
  return { env, log, clock: () => t, advance: (ms) => { t += ms; } };
}

// ---- version pinning
for (const n of [1, 2, 3, 5, 13, 33, 63]) {
  const s = stand({ versions: n });
  const p = await pinVersion("2611.26934", new Deadline(s.env.now), s.env);
  const heads = s.log.filter((x) => x.method === "HEAD"), gaps = heads.slice(1).map((x, k) => x.at - heads[k].at);
  ok(p.version === n && !p.capped && p.probes === heads.length && heads.length <= PROBES_MAX && gaps.every((g) => g >= PROBE_GAP_MS) && s.log.every((x) => x.method === "HEAD"),
    `pinVersion: ${n} version(s), the latest found, at most ${PROBES_MAX} HEAD probes at least ${PROBE_GAP_MS} ms apart`, { p, probes: heads.map((x) => +/v(\d+)$/.exec(x.url)[1]), gaps });
}
for (const n of [64, 70]) {
  const s = stand({ versions: n });
  const p = await pinVersion("2611.26934", new Deadline(s.env.now), s.env);
  ok(p.version === 64 && p.capped && p.probes === 7, `pinVersion: ${n} versions, v64 pinned and said capped ("later versions may exist")`, p);
}
{
  // (a probe that fails by network error pins an older version, never one not seen; its confirmation can move it up)
  const s = stand({ versions: 6, flaky: [4] });
  const p = await pinVersion("2611.26934", new Deadline(s.env.now), s.env);
  ok(p.version >= 2 && p.version <= 6 && p.probes <= PROBES_MAX, "pinVersion: a transient probe failure pins a version that exists, never one not seen", p);
  const s5 = stand({ versions: 5, flaky: [5] });
  const p5 = await pinVersion("2611.26934", new Deadline(s5.env.now), s5.env);
  ok(p5.version === 5, "pinVersion: the first failure confirmed once: a transient failure of the latest version is found again", p5);
}
{
  const s = stand({ versions: 0 });
  ok((await code(() => pinVersion("2611.26934", new Deadline(s.env.now), s.env))) === "network" && s.log.length === 1, "pinVersion: v1 failing is unavailable, after one probe");
  const d = stand({ versions: 64 });
  const dl = new Deadline(d.env.now, 3500);
  ok((await code(() => pinVersion("2611.26934", dl, d.env))) === "deadline" && d.log.length <= 4, "pinVersion: the import deadline stops the probes", d.log.length);
  const c = stand({ versions: 64 }), ac = new AbortController();
  const env = { ...c.env, sleep: async (ms) => { ac.abort(); await c.env.sleep(ms); } };
  ok((await code(() => pinVersion("2611.26934", new Deadline(c.env.now), { ...env, signal: ac.signal }))) === "cancelled" && c.log.length === 1, "pinVersion: Cancel stops the probes", c.log.length);
  const hs = stand({ versions: 2 });
  await pinVersion("2611.26934", new Deadline(hs.env.now), hs.env);
  ok(hs.log.every((x) => x.init.credentials === "omit" && x.init.redirect === "error" && x.init.referrerPolicy === "strict-origin" && x.url.startsWith("https://export.arxiv.org/src/2611.26934v")),
    "the requests: export.arxiv.org's versioned /src/ URL, credentials omitted, no redirects, strict-origin", hs.log.map((x) => x.init));
}

// ---- the download
const enc = (s) => new TextEncoder().encode(s);
const cat = (...a) => { const n = a.reduce((k, x) => k + x.length, 0), o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
function header(name, size, type = "0") {
  const h = new Uint8Array(512), put = (off, s) => h.set(enc(s), off);
  put(0, name); put(100, "0000644\0"); put(108, "0000000\0"); put(116, "0000000\0"); put(124, size.toString(8).padStart(11, "0") + "\0");
  put(136, "00000000000\0"); put(156, type); put(257, "ustar\u000000"); h.fill(0x20, 148, 156);
  let sum = 0; for (const b of h) sum += b; put(148, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}
const member = (name, text) => { const d = enc(text); return cat(header(name, d.length), d, new Uint8Array((512 - (d.length % 512)) % 512)); };
const MAIN = "\\documentclass{amsart}\n\\begin{document}\nHello \\input{sec}.\n\\end{document}\n";
const targz = gzipSync(cat(member("paper.tex", MAIN), member("sec.tex", "a section\n"), member("refs.bib", "@misc{a, title={T}}\n"), new Uint8Array(1024)));
{
  const s = stand({ versions: 1, body: targz, chunks: 7 });
  const r = await fetchSource("2611.26934", 1, new Deadline(s.env.now), s.env);
  ok(r.kind === "source" && r.extracted.shape === "tar" && r.extracted.files.map((f) => f.path).join() === "paper.tex,sec.tex,refs.bib" && r.main.main === "paper.tex" && /^[0-9a-f]{64}$/.test(r.extracted.tarSha256) && s.log[0].method === "GET",
    "a tar.gz in 7-byte chunks: its files, the main one found, the tarball's SHA-256", { kind: r.kind, main: r.main, files: r.extracted?.files.map((f) => f.path) });
  const one = gzipSync(enc(MAIN));
  const s1 = stand({ versions: 1, body: one, chunks: 1 });
  const r1 = await fetchSource("math/0211159", 1, new Deadline(s1.env.now), s1.env);
  ok(r1.kind === "source" && r1.extracted.shape === "single" && r1.main.main === "main.tex" && s1.log[0].url === "https://export.arxiv.org/src/math/0211159v1",
    "a single gzipped .tex, one byte at a time: kept as main.tex", { kind: r1.kind, main: r1.main });
  const sn = stand({ versions: 1, body: gzipSync(new Uint8Array(300).fill(1)) });
  ok((await code(() => fetchSource("2611.26934", 1, new Deadline(sn.env.now), sn.env))) === "source", "a single gzipped file that isn't TeX: refused, nothing kept");
}
{
  const rec = JSON.parse(readFileSync(join(import.meta.dir ?? new URL(".", import.meta.url).pathname, "..", "tar", "fixtures", "arxiv-recorded.json"), "utf8")).rows;
  const row = (c) => rec.find((x) => x.case === c);
  const pdf = row("pdf-only"), first = Uint8Array.from(Buffer.from(pdf.first_bytes_b64, "base64"));
  const sp = stand({ versions: 1, body: cat(first, new Uint8Array(100_000)), chunks: 3 });
  const rp = await fetchSource("2504.00698", 2, new Deadline(sp.env.now), sp.env);
  ok(rp.kind === "pdf" && sp.log.cancelled && sp.log.pulled < 100, "a PDF-only paper (arXiv's recorded answer): reported, its download cancelled after its first bytes", { kind: rp.kind, pulled: sp.log.pulled });
  const w = row("withdrawn");
  const sw = stand({ versions: 1, body: Uint8Array.from(Buffer.from(w.first_bytes_b64, "base64")), status: w.status });
  ok((await code(() => fetchSource("1612.00125", 2, new Deadline(sw.env.now), sw.env))) === "status", "a withdrawn version (arXiv's recorded 404, readable here): no source");
  const sh = stand({ versions: 1, body: enc("<!DOCTYPE html><html>maintenance</html>") });
  ok((await fetchSource("2611.26934", 1, new Deadline(sh.env.now), sh.env)).kind === "none", "an HTML page with 200: no source, nothing kept");
  for (const st of [429, 503]) {
    const sb = stand({ versions: 1, body: enc("slow down"), status: st, headers: { "retry-after": "60" } });
    ok((await code(() => fetchSource("2611.26934", 1, new Deadline(sb.env.now), sb.env))) === "busy" && sb.log.length === 1, `a ${st}: arXiv asked us to wait, no retry`);
  }
}
{
  const big = stand({ versions: 1, body: targz, headers: { "content-length": String(50 * 2 ** 20 + 1) } });
  const bigCode = await code(() => fetchSource("2611.26934", 1, new Deadline(big.env.now), big.env));
  ok(bigCode === "too-large" && !(big.log.pulled > 4096), "a Content-Length over the download cap: refused before any byte is read", { bigCode, pulled: big.log.pulled });
  const at = stand({ versions: 1, body: targz, headers: { "content-length": String(targz.length) } });
  ok((await fetchSource("2611.26934", 1, new Deadline(at.env.now), at.env, { download: targz.length })).kind === "source", "a download exactly at its cap: read");
  const past = stand({ versions: 1, body: targz, chunks: 16 });
  const pastCode = await code(() => fetchSource("2611.26934", 1, new Deadline(past.env.now), past.env, { download: targz.length - 1 }));
  // (and one past a cap half way through: the rest never read)
  const half = stand({ versions: 1, body: targz, chunks: 16 }), halfCode = await code(() => fetchSource("2611.26934", 1, new Deadline(half.env.now), half.env, { download: 64 }));
  ok(pastCode === "source" && halfCode === "source" && half.log.cancelled && half.log.pulled < targz.length,
    "a download one byte past its cap, with no Content-Length: refused while it streams, the read cancelled", { pastCode, halfCode, cancelled: half.log.cancelled, pulled: half.log.pulled });
}
{
  const st = stand({ versions: 1, body: targz, chunks: 64, stall: true });
  ok((await code(() => fetchSource("2611.26934", 1, new Deadline(st.env.now), st.env))) === "deadline", "the import deadline passing mid-download stops it, nothing kept");
  const c = stand({ versions: 1, body: targz, chunks: 64 }), ac = new AbortController();
  ac.abort();
  ok((await code(() => fetchSource("2611.26934", 1, new Deadline(c.env.now), { ...c.env, signal: ac.signal }))) === "cancelled" && c.log.length === 0, "Cancel before the download: nothing requested");
  const dl = stand({ versions: 1, body: targz }), d = new Deadline(dl.env.now, 10);
  dl.advance(20);
  ok((await code(() => fetchSource("2611.26934", 1, d, dl.env))) === "deadline" && dl.log.length === 0, "the deadline already past: nothing requested");
}

console.log(failures ? `FAIL: ${failures} of ${checks}` : `ok: an arXiv paper's source, ${checks} checks`);
process.exit(failures ? 1 : 0);
