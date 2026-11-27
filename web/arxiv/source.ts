// An arXiv paper's LaTeX source, fetched by the reader's own browser (design/arxiv-proxy.md §1–§3): the address
// parsed to a canonical id (§2), the version pinned by HEAD probes when the link names none (§3), and the one source
// download read through the bounded extractor (web/tar/read.ts), its shape decided by its bytes (gzip, a PDF, or
// anything else). No DOM and no workspace: the page (a later change) holds the per-browser lock and the pacing, writes
// the files, and opens the main one. Everything is injected (fetch, the clock, sleep), so tests drive it with
// arXiv's recorded answers (web/tar/fixtures/arxiv-recorded.json).

import { CAPS, SourceExtractor, TarError, sniff, type Caps, type Extracted } from "../tar/read.ts";
import { mainFileOf, type Main } from "../tar/main-file.ts";

/** A paper: its canonical id ("2611.26934", "math/0211159") and the version the link names, if any. */
export type ArxivId = { id: string; version: number | null };

export type ArxivErrorCode = "address" | "deadline" | "cancelled" | "network" | "busy" | "status" | "too-large" | "source";

export class ArxivError extends Error {
  constructor(public code: ArxivErrorCode, message: string) {
    super(message);
    this.name = "ArxivError";
  }
}

/** The most versions a link may name (`v1`–`v999`, §8 ruling 3's tests). */
export const VERSION_MAX = 999;
/** Version pinning (§3): at most this many HEAD probes, starting at least this far apart, each with this timeout;
 * doubling stops at VERSION_PROBE_TOP, so a paper with more versions pins that one ("later versions may exist"). */
export const PROBES_MAX = 16, PROBE_GAP_MS = 1000, PROBE_TIMEOUT_MS = 5000, VERSION_PROBE_TOP = 64;
/** The whole import's deadline (LIMITS L5), from when the person acts. */
export const IMPORT_DEADLINE_MS = 120_000;

const ORIGIN = "https://export.arxiv.org";
/** arXiv's archives that had old-style ids (archive/YYMMNNN), the fixed list. */
const OLD_ARCHIVES = new Set(["acc-phys", "adap-org", "alg-geom", "ao-sci", "astro-ph", "atom-ph", "bayes-an", "chao-dyn", "chem-ph",
  "cmp-lg", "comp-gas", "cond-mat", "cs", "dg-ga", "funct-an", "gr-qc", "hep-ex", "hep-lat", "hep-ph", "hep-th", "math", "math-ph",
  "mtrl-th", "nlin", "nucl-ex", "nucl-th", "patt-sol", "physics", "plasm-ph", "q-alg", "q-bio", "quant-ph", "solv-int", "supr-con"]);

const NOT_AN_ID = "That isn't an arXiv paper id.";

/** The version suffix: "" for none, else 1 to VERSION_MAX with no leading zero. */
function versionOf(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  if (!/^[1-9][0-9]{0,2}$/.test(v)) throw new ArxivError("address", NOT_AN_ID);
  return Number(v);
}

/** A month YYMM that exists in arXiv's numbering: new-style from 0704 (5 digits from 1501), old-style 9108 to 0703. */
const monthOk = (yymm: string) => +yymm.slice(2) >= 1 && +yymm.slice(2) <= 12;

/** The paper `rest` names: an id, with an optional version, or a pasted abs/pdf/src/e-print URL (§2). Anything else
 * throws ArxivError("address"). Only the parsed id goes into a request (srcUrl), never the text given. */
export function parseArxiv(rest: string): ArxivId {
  let s = String(rest ?? "").trim();
  if (s.length > 200) throw new ArxivError("address", NOT_AN_ID);
  s = s.replace(/^arxiv:/i, "");
  const url = /^(?:https?:\/\/)?(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|src|e-print)\/(.+)$/i.exec(s);
  if (url) s = url[1].replace(/\.pdf$/i, "").replace(/[?#].*$/, "");
  else if (/[:?#]|^\/|\/\//.test(s)) throw new ArxivError("address", NOT_AN_ID);
  const nu = /^([0-9]{4})\.([0-9]{4,5})(?:v([0-9]+))?$/.exec(s);
  if (nu) {
    const [, yymm, num, v] = nu;
    if (!monthOk(yymm) || +yymm < 704) throw new ArxivError("address", NOT_AN_ID);
    if ((num.length === 4) !== (+yymm < 1501)) throw new ArxivError("address", NOT_AN_ID);
    return { id: `${yymm}.${num}`, version: versionOf(v) };
  }
  const old = /^([a-z]+(?:-[a-z]+)?)(?:\.[A-Z]{2})?\/([0-9]{7})(?:v([0-9]+))?$/.exec(s);
  if (old) {
    const [, archive, num, v] = old;
    const yy = +num.slice(0, 2), mm = +num.slice(2, 4);
    if (!OLD_ARCHIVES.has(archive) || mm < 1 || mm > 12 || (yy > 7 && yy < 91) || (yy === 7 && mm > 3) || (yy === 91 && mm < 8)) throw new ArxivError("address", NOT_AN_ID);
    return { id: `${archive}/${num}`, version: versionOf(v) };
  }
  throw new ArxivError("address", NOT_AN_ID);
}

/** The source URL of a version: the canonical id percent-encoded by segment. */
export const srcUrl = (id: string, version: number) => `${ORIGIN}/src/${id.split("/").map(encodeURIComponent).join("/")}v${version}`;
/** The abstract page, which every refusal links to (arXiv asks for links to it). */
export const absUrl = (id: string, version?: number | null) => `https://arxiv.org/abs/${id}${version ? `v${version}` : ""}`;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type Env = {
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** the person's Cancel */
  signal?: AbortSignal;
};

/** The import's one deadline (LIMITS L5): started when the person acts, checked before every step. */
export class Deadline {
  readonly at: number;
  constructor(private now: () => number = Date.now, ms = IMPORT_DEADLINE_MS) {
    this.at = now() + ms;
  }
  left(): number {
    return this.at - this.now();
  }
  check(): void {
    if (this.left() <= 0) throw new ArxivError("deadline", "The import took longer than two minutes, so it was stopped and nothing was kept.");
  }
}

const defaults = (env: Env) => ({
  fetch: env.fetch ?? (globalThis.fetch.bind(globalThis) as Fetch),
  now: env.now ?? Date.now,
  sleep: env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  signal: env.signal,
});

const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new ArxivError("cancelled", "Cancelled; nothing was kept.");
};

/** One request, aborted at `ms` or on Cancel. `redirect: "error"`, `credentials: "omit"`, `strict-origin` (§3). */
async function request(fetch: Fetch, url: string, method: "GET" | "HEAD", ms: number, signal?: AbortSignal): Promise<{ r: Response; done: () => void; ac: AbortController }> {
  const ac = new AbortController();
  const stop = () => ac.abort();
  signal?.addEventListener("abort", stop, { once: true });
  const t = setTimeout(stop, Math.max(0, ms));
  const done = () => { clearTimeout(t); signal?.removeEventListener("abort", stop); };
  try {
    const r = await fetch(url, { method, credentials: "omit", redirect: "error", referrerPolicy: "strict-origin", signal: ac.signal });
    return { r, done, ac };
  } catch {
    done();
    cancelled(signal);
    throw new ArxivError("network", "arXiv is unavailable, or the network failed.");
  }
}

export type Pinned = { version: number; probes: number; capped: boolean };

/** The latest version arXiv answers for, by HEAD probes (§3): v1, then doubling (v2, v4, … v64) until one fails, then
 * a binary search between the last success and the first failure, then one confirmation of the first failure. A
 * failure (a 404 has no CORS headers, so it is a network error here) only ever makes the pin older, never names a
 * version that wasn't seen to exist. At most 13 probes by this search (1 + 6 doublings + 5 halvings + 1), within
 * PROBES_MAX, starting PROBE_GAP_MS apart, each PROBE_TIMEOUT_MS at
 * most and within the deadline; Cancel stops them. v1 failing is "unavailable". */
export async function pinVersion(id: string, deadline: Deadline, env: Env = {}): Promise<Pinned> {
  const { fetch, now, sleep, signal } = defaults(env);
  let probes = 0, lastStart = -Infinity;
  const exists = async (v: number): Promise<boolean> => {
    cancelled(signal);
    deadline.check();
    const wait = lastStart + PROBE_GAP_MS - now();
    if (wait > 0) await sleep(wait);
    cancelled(signal);
    deadline.check();
    probes++;
    lastStart = now();
    try {
      const { r, done } = await request(fetch, srcUrl(id, v), "HEAD", Math.min(PROBE_TIMEOUT_MS, deadline.left()), signal);
      done();
      return r.status === 200;
    } catch (e) {
      if (e instanceof ArxivError && e.code === "network") { deadline.check(); return false; }
      throw e;
    }
  };
  if (!(await exists(1))) throw new ArxivError("network", "arXiv is unavailable, or the network failed.");
  let lo = 1, hi = 0;
  for (let v = 2; v <= VERSION_PROBE_TOP; v *= 2) {
    if (await exists(v)) lo = v;
    else { hi = v; break; }
  }
  if (hi === 0) return { version: lo, probes, capped: true };
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (await exists(mid)) lo = mid;
    else hi = mid;
  }
  // (the first failure confirmed: a transient one that now answers moves the pin to it, never past it)
  if (await exists(hi)) lo = hi;
  return { version: lo, probes, capped: false };
}

export type Source =
  | { kind: "source"; extracted: Extracted; main: Main }
  | { kind: "pdf" }
  | { kind: "none" };

/** The bytes needed to tell the shapes apart (sniff: gzip's 2, "%PDF-"'s 5). */
const SNIFF_BYTES = 5;

/** The source of one version (§3): GET, 200 required, a Content-Length over the download cap refused before reading,
 * the body read chunk by chunk within the deadline and Cancel, its first bytes deciding the shape. gzip goes through
 * SourceExtractor (every cap, the tarball's SHA-256 as it streams), then mainFileOf; a PDF or anything else is
 * cancelled at once and reported, nothing kept. A readable 429 or 503 is "busy", with no retry. */
export async function fetchSource(id: string, version: number, deadline: Deadline, env: Env = {}, caps: Partial<Caps> = {}): Promise<Source> {
  const { fetch, signal } = defaults(env);
  const cap = { ...CAPS, ...caps };
  cancelled(signal);
  deadline.check();
  const { r, done, ac } = await request(fetch, srcUrl(id, version), "GET", deadline.left(), signal);
  // (after every await and before every return: Cancel, then the deadline; a refusal before the body is read cancels
  //  it and aborts the request, so nothing more arrives)
  const still = () => { cancelled(signal); deadline.check(); };
  try {
    still();
    if (r.status === 429 || r.status === 503) throw new ArxivError("busy", "arXiv asked us to wait. Try again in a few minutes.");
    if (r.status !== 200 || !r.body) throw new ArxivError("status", `arXiv answered ${r.status}, so it didn't send a source.`);
    const len = Number(r.headers.get("content-length"));
    if (r.headers.has("content-length") && Number.isFinite(len) && len > cap.download) throw new ArxivError("too-large", `This paper's source is ${len} bytes, over the ${cap.download} Sagebrush reads.`);
    const reader = r.body.getReader();
    const head: Uint8Array[] = [];
    let headLen = 0, x: SourceExtractor | null = null;
    try {
      for (;;) {
        let step;
        try { step = await reader.read(); }
        catch { cancelled(signal); deadline.check(); throw new ArxivError("network", "The download from arXiv failed part way."); }
        still();
        if (step.done) break;
        const chunk = step.value;
        if (x) { x.push(chunk); continue; }
        head.push(chunk); headLen += chunk.length;
        if (headLen < SNIFF_BYTES) continue;
        const kind = sniff(join(head, headLen));
        if (kind !== "gzip") { await reader.cancel().catch(() => {}); still(); return { kind: kind === "pdf" ? "pdf" : "none" }; }
        x = new SourceExtractor(caps);
        for (const h of head) x.push(h);
        head.length = 0;
      }
      if (!x) {
        const kind = headLen ? sniff(join(head, headLen)) : "other";
        if (kind !== "gzip") { still(); return { kind: kind === "pdf" ? "pdf" : "none" }; }
        x = new SourceExtractor(caps);
        for (const h of head) x.push(h);
      }
      still();
      const extracted = x.end();
      still();
      const main = mainFileOf(extracted.files);
      still();
      return { kind: "source", extracted, main };
    } catch (e) {
      await reader.cancel().catch(() => {});
      if (e instanceof TarError) throw new ArxivError("source", `arXiv's source couldn't be opened: ${e.message}.`);
      if (signal?.aborted) throw new ArxivError("cancelled", "Cancelled; nothing was kept.");
      if (ac.signal.aborted) deadline.check();
      throw e;
    }
  } catch (e) {
    // (refused before the body was read: it is cancelled and the request aborted)
    if (r.body && !r.body.locked) await r.body.cancel().catch(() => {});
    ac.abort();
    throw e;
  } finally {
    done();
  }
}

function join(parts: Uint8Array[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
