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
/** `error`: the check itself failed (the network, a 5xx, no answer in time), which says nothing
 * about sharing or the sign-in; without it, enabled: false means this site has no share API */
export type ShareStatus = { enabled: false; error?: true } | { enabled: true; me: Me | null };

/** Whether this site has sharing, and who is signed in (within `ms`). */
export async function shareStatus(ms = 10_000): Promise<ShareStatus> {
  try {
    const r = await fetch("/api/share/me", { credentials: "same-origin", signal: AbortSignal.timeout(ms) });
    if (r.status === 401) return { enabled: true, me: null };
    if (r.status === 404) return { enabled: false };
    if (!r.ok) return { enabled: false, error: true };
    return { enabled: true, me: (await r.json()) as Me };
  } catch {
    return { enabled: false, error: true };
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

/** A file to upload, read only when its turn comes (share-ux-plan r2 §1). */
export interface LazyFile {
  path: string;
  /** its size, if known beforehand (for the progress) */
  size?: number;
  /** its bytes; may throw (the file changed: the upload stops, and no version is created) */
  read: () => Promise<Uint8Array>;
}

/** Bytes read and hashed before the server is asked which of them it is missing. */
export const UPLOAD_BATCH_BYTES = 64 * 1024 * 1024;

/**
 * Upload files as a new version of a collection (a new collection if `id`
 * is null).  Each file is read once, in order; a batch of at most
 * `batchBytes` (or one larger file) is hashed, the server says which of it
 * it is missing, those are uploaded, and the batch's bytes are dropped.  The
 * batch is sent *before* the next file is read whenever that file, by its
 * listed size, would take the batch over `batchBytes`, or its size isn't
 * known (#172 r2's review, LIMIT-SHAREB-1): so at most max(batchBytes, the
 * largest file) is held at a time, by listed sizes (a file that grew since it
 * was listed counts as read).  The version
 * is created only after every file was read and uploaded: a file that can't
 * be read stops the upload with no version.  `progress(done, total)` counts
 * bytes read (total: the files' known sizes).
 */
export async function uploadCollection(
  o: { id: string | null; title: string; license?: string; files: LazyFile[] },
  progress: (done: number, total: number) => void = () => {},
  opts: { batchBytes?: number } = {},
): Promise<{ id: string; version: string; url: string; frozen: string }> {
  const limit = opts.batchBytes ?? UPLOAD_BATCH_BYTES;
  const total = o.files.reduce((s, f) => s + (f.size ?? 0), 0);
  const id = o.id ?? (await api("POST", "/api/share/collections", { title: o.title })).id;
  const manifest: { path: string; sha256: string; size: number }[] = [];
  const sent = new Set<string>();
  let done = 0;
  progress(0, total);
  let batch: { path: string; data: Uint8Array; sha256: string }[] = [];
  let held = 0;
  const flush = async () => {
    if (!batch.length) return;
    const { missing } = await api("POST", "/api/share/check", { blobs: batch.map((f) => ({ sha256: f.sha256, size: f.data.length })) });
    for (const f of batch) {
      if (!missing.includes(f.sha256) || sent.has(f.sha256)) continue;
      const r = await fetch(`/api/share/blob/${f.sha256}`, { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: f.data as BufferSource });
      if (!r.ok) throw new Error(`${f.path}: ${(await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`}`);
      sent.add(f.sha256);
    }
    batch = [];
    held = 0;
  };
  for (const f of o.files) {
    if (held && (f.size === undefined || held + f.size > limit)) await flush();
    const data = await f.read();
    const sha256 = hex(await crypto.subtle.digest("SHA-256", data as BufferSource));
    manifest.push({ path: f.path, sha256, size: data.length });
    if (held && held + data.length > limit) await flush();
    batch.push({ path: f.path, data, sha256 });
    held += data.length;
    done += f.size ?? data.length;
    progress(Math.min(done, total || done), total || done);
  }
  await flush();
  const v = await api("POST", `/api/share/collections/${id}/versions`, { title: o.title, license: o.license || undefined, files: manifest });
  return { id, version: v.version, url: new URL(v.url, location.href).href, frozen: new URL(v.frozen, location.href).href };
}
