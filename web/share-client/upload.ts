// Uploading a collection from the page (design/sharing.md): hash each file,
// ask which ones the server is missing, upload those, then commit the
// version (for a new share, the request that makes its collection too, so a
// failed upload leaves none behind).  The API is web/share/server.ts, on the
// page's own origin.

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

/**
 * A new share's attempt that already made a share with other contents (`used`, with that share),
 * or whose share was deleted since (`retired`): never a success, and not retried as it was.
 */
export class AttemptError extends Error {
  constructor(readonly kind: "used" | "retired", readonly share?: { id: string; version: string; url: string }) {
    super(kind === "used" ? "an earlier upload of this notebook was shared with other files" : "this notebook's earlier share was deleted");
  }
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(path, { method, credentials: "same-origin", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const v = await r.json().catch(() => ({}));
  if (r.status === 409 && v.error === "attempt_used") throw new AttemptError("used", { id: v.collection, version: v.version, url: new URL(v.url, location.href).href });
  if (r.status === 410 && v.error === "attempt_retired") throw new AttemptError("retired");
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
 * Upload files as a new version of a collection, or (`id` null) as a new
 * share, made by `attempt` (32 hex digits, kept with the notebook until the
 * share is made: a retry of it gets that share back, never another).  Each
 * file is read once, in order; a batch of at most `batchBytes` (or one
 * larger file) is hashed, the server says which of it
 * it is missing, those are uploaded, and the batch's bytes are dropped.  The
 * batch is sent *before* the next file is read whenever that file, by its
 * listed size, would take the batch over `batchBytes`, or its size isn't
 * known (#172 r2's review, LIMIT-SHAREB-1): so at most max(batchBytes, the
 * largest file) is held at a time, by listed sizes (a file that grew since it
 * was listed counts as read).  The version
 * is created only after every file was read and uploaded: a file that can't
 * be read stops the upload with no version (and, for a new share, no
 * collection).  `progress(done, total)` counts
 * bytes read (total: the files' known sizes).
 */
export async function uploadCollection(
  o: { id: string | null; attempt?: string; title: string; license?: string; files: LazyFile[] },
  progress: (done: number, total: number) => void = () => {},
  opts: { batchBytes?: number; beforeCommit?: () => void | Promise<void> } = {},
): Promise<{ id: string; version: string; url: string; frozen: string }> {
  const limit = opts.batchBytes ?? UPLOAD_BATCH_BYTES;
  const total = o.files.reduce((s, f) => s + (f.size ?? 0), 0);
  if (o.id === null && !/^[0-9a-f]{32}$/.test(o.attempt ?? "")) throw new Error("a new share needs its attempt");
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
  const body = { title: o.title, license: o.license || undefined, files: manifest };
  // (a new share: its collection is made with this version, by this one request)
  if (o.id === null) await opts.beforeCommit?.();
  // (a new share: its own path, which a server from before this answers with 404, creating nothing)
  const v = o.id === null ? await api("POST", "/api/share/first-upload", { ...body, attempt: o.attempt }) : await api("POST", `/api/share/collections/${o.id}/versions`, body);
  return { id: o.id ?? v.collection, version: v.version, url: new URL(v.url, location.href).href, frozen: new URL(v.frozen, location.href).href };
}
