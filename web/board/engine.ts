// The code engine of a board downloaded as HTML (export.ts; design/engines.md).
// A downloaded file is never cross-origin isolated, so the runner's broker
// (a SharedArrayBuffer) can't work there.  Python runs in the runner's files
// mode instead: RunnerWorker given the engine's bytes, in a sandboxed srcdoc
// frame with no network, whose worker reads them from blob: URLs.
//
// The bytes are carried in the file (gzip, base64: Download as HTML with
// "Include Python") or fetched from <site>/engine/<id>/, the engine this
// script was built with.  Each part is checked against the SHA-256 built into
// this script (__SB_ENGINE__), so neither an edited file nor a changed server
// can substitute an engine.  A board set to run with the latest engine
// (doc.engine "latest") takes the site's latest.json instead, if its api is
// this script's, each part checked against that engine's manifest (trusted
// as the site is, over HTTPS), whose format, id and api must be latest.json's
// and whose content must give that id (web/engine-id.mts, HARD-CAC-4); else,
// or offline, its own.  (The file itself is not signed: an edited file can
// name another site, or carry another script.)

import type { EngineParts } from "./code";
import { engineIdText, isManifest } from "../engine-id.mts";

/** The engine this script was built with (web/build.ts): its id, its api, and its files' SHA-256s. */
declare const __SB_ENGINE__: { id: string; api: number; files: Record<string, string> } | undefined;
export const OWN_ENGINE = typeof __SB_ENGINE__ === "undefined" ? null : __SB_ENGINE__;

/** Where a downloaded file's engine comes from: the site it was downloaded from. */
export interface EngineRef { site: string; id: string }

/** The parts a downloaded file needs, of an engine with files `names`: the
 * Python library's sources (web/lib-chunks.mts), and for Sage its compiled
 * modules too (those of Sage's start and the scientific modules', which it
 * waits for). */
export const engineFiles = (sage: boolean, names: string[]) => [
  "sagebrush-worker.js", "sagebrush-engine.wasm", "sagebrush-notebook.js", "sagebrush-analyze.js", "sagebrush-viewer3d.js", "sagebrush-graphview.js",
  ...names.filter((n) => /^lib\/[\w.-]+\.src\.[0-9a-f]{16}\.json$/.test(n) || (sage && /^lib\/(core|sci|sage)\.pre\.[0-9a-f]{16}\.json$/.test(n))).sort(),
];

type Bytes = (name: string) => Promise<ArrayBuffer>;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256 = async (b: ArrayBuffer) => hex(await crypto.subtle.digest("SHA-256", b));

/** gzip, and base64 for a <script> (export.ts) */
export async function pack(b: ArrayBuffer): Promise<string> {
  const z = await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  const u = new Uint8Array(z);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
async function unpack(s: string): Promise<ArrayBuffer> {
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

/** The engine's parts this file carries (none: null). */
export function embedded(): Bytes | null {
  const els = document.querySelectorAll<HTMLScriptElement>('script[type="application/octet-stream"][data-sb-engine]');
  if (!els.length) return null;
  const by = new Map([...els].map((e) => [e.dataset.sbEngine!, e]));
  return async (name) => {
    const e = by.get(name);
    if (!e) throw new Error(`${name}: not in this file`);
    return unpack(e.textContent!.trim());
  };
}

/** The engine's parts carried in this file, as export.ts writes them again. */
export function embeddedText(): Map<string, string> {
  return new Map([...document.querySelectorAll<HTMLScriptElement>('script[type="application/octet-stream"][data-sb-engine]')].map((e) => [e.dataset.sbEngine!, e.textContent!.trim()]));
}

/** The engine's parts from `base` (<site>/engine/<id>/). */
export function fetched(base: string): Bytes {
  return async (name) => {
    const r = await fetch(new URL(name, base));
    if (!r.ok) throw new Error(`${name}: ${r.status} ${r.statusText}`);
    return r.arrayBuffer();
  };
}

/** `bytes`, each part checked against its SHA-256 in `sums`. */
export function checked(bytes: Bytes, sums: Record<string, string>): Bytes {
  return async (name) => {
    const b = await bytes(name);
    if (!sums[name] || (await sha256(b)) !== sums[name]) throw new Error(`${name} is not the engine's own (its SHA-256 differs): refused`);
    return b;
  };
}

/** Where a downloaded file's code comes from, as `use` says: the latest
 * engine (if the site has one this script can talk to), else its own,
 * carried in the file or fetched by its id. */
export async function chooseEngine(ref: EngineRef, use: "pinned" | "latest" | undefined): Promise<{ bytes: Bytes; id: string; names: string[] }> {
  const own = OWN_ENGINE;
  if (!own || own.id !== ref.id) throw new Error("this file's script has no engine of its own");
  if (use === "latest") {
    try {
      const latest = await (await fetch(new URL("engine/latest.json", ref.site), { cache: "no-store" })).json();
      if (latest?.api === own.api && typeof latest.id === "string" && /^[0-9a-f]{20}$/.test(latest.id) && latest.id !== own.id) {
        const base = new URL(`engine/${latest.id}/`, ref.site).href;
        const m = await (await fetch(new URL("manifest.json", base))).json();
        if (isManifest(m) && m.id === latest.id && m.api === own.api && (await sha256(new TextEncoder().encode(engineIdText(m.api, m.files)).buffer as ArrayBuffer)).slice(0, 20) === m.id) {
          const sums = Object.fromEntries(Object.entries(m.files).map(([k, v]) => [k, v.sha256]));
          return { bytes: checked(fetched(base), sums), id: latest.id, names: Object.keys(sums) };
        }
      }
    } catch {}
  }
  // (a part the file doesn't carry, e.g. the Sage library in a file made
  // before offline mode carried every language's: from the site, checked the same)
  const carried = embedded(), site = fetched(new URL(`engine/${own.id}/`, ref.site).href);
  return { bytes: checked(carried ? (name) => carried(name).catch(() => site(name)) : site, own.files), id: own.id, names: Object.keys(own.files) };
}

/** The engine's parts from `bytes`: all loaded and checked before Python
 * starts.  `math`: the file's own math module (sagebrush-math.js), for the
 * notebook's outputs. */
export function fileEngine(load: () => Promise<{ bytes: Bytes; names: string[] }>, o: { sage: boolean; math?: string | null }): EngineParts {
  const urls = new Map<string, string>(), raw = new Map<string, ArrayBuffer>();
  const type = (n: string) => (n.endsWith(".js") ? "text/javascript" : n.endsWith(".wasm") ? "application/wasm" : "application/json");
  return {
    async module() {
      const { bytes, names: all } = await load();
      const names = engineFiles(o.sage, all);
      const got = await Promise.all(names.map((n) => bytes(n).catch((e) => {
        throw new Error(e?.message === "Failed to fetch" ? `this file's code needs parts of Sagebrush it doesn't carry (${n}), from the site it came from, which can't be reached (no network?). Download it again in offline mode.` : String(e?.message ?? e));
      })));
      names.forEach((n, i) => { raw.set(n, got[i]); urls.set(n, URL.createObjectURL(new Blob([got[i]], { type: type(n) }))); });
      if (o.math) urls.set("sagebrush-math.js", URL.createObjectURL(new Blob([o.math], { type: "text/javascript" })));
      return import(urls.get("sagebrush-notebook.js")!);
    },
    // (the same bytes for each worker: Stop restarts it)
    worker: (mod) => new mod.RunnerWorker(null, { files: Object.fromEntries([...raw].filter(([n]) => /^(sagebrush-(worker\.js|engine\.wasm)|lib\/.*)$/.test(n))) }),
    analyzer: () => new Worker(urls.get("sagebrush-analyze.js")!),
    assets: () => ({ assetUrl: (name: string) => urls.get(name) }),
  };
}
