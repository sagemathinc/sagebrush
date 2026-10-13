// Uploading a collection from the page (design/sharing.md): hash each file,
// ask which ones the server is missing, upload those, then commit the
// version.  The API is web/share/server.ts, on the page's own origin.

export interface Me {
  account_id: string;
  name?: string;
  email?: string;
  usage: number;
  limits: { storage_bytes: number; max_file_bytes: number } | null;
}
export type ShareStatus = { enabled: false } | { enabled: true; me: Me | null };

/** Whether this site has sharing, and who is signed in. */
export async function shareStatus(): Promise<ShareStatus> {
  try {
    const r = await fetch("/api/share/me", { credentials: "same-origin" });
    if (r.status === 401) return { enabled: true, me: null };
    if (!r.ok) return { enabled: false };
    return { enabled: true, me: (await r.json()) as Me };
  } catch {
    return { enabled: false };
  }
}

export const signInUrl = (returnTo: string) => `/auth/login?return=${encodeURIComponent(returnTo)}`;

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(path, { method, credentials: "same-origin", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(v.error ?? `HTTP ${r.status}`);
  return v;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Upload files as a new version of a collection (a new collection if `id`
 * is null).  `progress(done, total)` counts bytes uploaded.
 */
export async function uploadCollection(
  o: { id: string | null; title: string; license?: string; files: { path: string; data: Uint8Array }[] },
  progress: (done: number, total: number) => void = () => {},
): Promise<{ id: string; version: string; url: string; frozen: string }> {
  const files = await Promise.all(o.files.map(async (f) => ({ ...f, sha256: hex(await crypto.subtle.digest("SHA-256", f.data)), size: f.data.length })));
  const id = o.id ?? (await api("POST", "/api/share/collections", { title: o.title })).id;
  const { missing } = await api("POST", "/api/share/check", { blobs: files.map(({ sha256, size }) => ({ sha256, size })) });
  const todo = files.filter((f, i) => missing.includes(f.sha256) && files.findIndex((g) => g.sha256 === f.sha256) === i);
  const total = todo.reduce((s, f) => s + f.size, 0);
  let done = 0;
  progress(0, total);
  for (const f of todo) {
    const r = await fetch(`/api/share/blob/${f.sha256}`, { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: f.data });
    if (!r.ok) throw new Error(`${f.path}: ${(await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`}`);
    done += f.size;
    progress(done, total);
  }
  const v = await api("POST", `/api/share/collections/${id}/versions`, { title: o.title, license: o.license || undefined, files: files.map(({ path, sha256, size }) => ({ path, sha256, size })) });
  return { id, version: v.version, url: new URL(v.url, location.href).href, frozen: new URL(v.frozen, location.href).href };
}
