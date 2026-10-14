// An engine's id (design/engines.md): the first 20 hex digits of the SHA-256
// of everything that decides how it runs: the format, its api, and each
// file's name, SHA-256, size and response headers (the runner page's CSP
// among them).  So a change of headers alone is a new engine, published
// beside the old one (SEC-CAC-2).  web/build.ts makes it; a downloaded
// board recomputes it for the latest engine's manifest (board/engine.ts).

export interface EngineFile { sha256: string; size: number; headers: Record<string, string> }
export interface EngineManifest { format: "sagebrush-engine"; id: string; api: number; files: Record<string, EngineFile> }

const byName = <T>(o: Record<string, T>): [string, T][] => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** The text whose SHA-256 the id is. */
export function engineIdText(api: number, files: Record<string, EngineFile>): string {
  return JSON.stringify(["sagebrush-engine", api, byName(files).map(([f, d]) => [f, d.sha256, d.size, byName(d.headers)])]);
}

/** Whether `m` is a well-formed manifest (not whether its id is right). */
export function isManifest(m: any): m is EngineManifest {
  return !!m && typeof m === "object" && m.format === "sagebrush-engine" && typeof m.id === "string" && /^[0-9a-f]{20}$/.test(m.id)
    && Number.isInteger(m.api) && !!m.files && typeof m.files === "object" && !Array.isArray(m.files)
    && Object.values(m.files).every((d: any) => !!d && typeof d === "object" && typeof d.sha256 === "string" && /^[0-9a-f]{64}$/.test(d.sha256)
      && Number.isInteger(d.size) && d.size >= 0 && !!d.headers && typeof d.headers === "object" && Object.values(d.headers).every((v) => typeof v === "string"));
}
