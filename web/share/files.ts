// The user-content domain (files.cocalcusercontent.com): files of shared
// collections, and nothing else.  A file is read through its collection,
// /c/<collection>/<sha256>, and only if a version of that collection has it:
// a hash alone reads nothing (not another collection's files, not an upload
// never shared), and "not shared" and "absent" are the same 404.  Uploaded bytes are never served from
// sagebrush.space, and never as something a browser would render: every
// response is an attachment of type application/octet-stream (manifests:
// application/json), with nosniff and a sandboxing CSP, so an uploaded
// .html or .svg can't become a page on any origin.  Pages read the files
// with CORS; a file's bytes never change (its name is their hash), so a
// response is cached in the browser for good.  Range requests are supported, so code that reads part
// of a large file doesn't download the rest.
//
//   GET|HEAD /c/<collection>/<sha256>     a file of the collection

import type { D1, R2 } from "./server.ts";

export interface FilesEnv { SHARE_BUCKET?: R2; SHARE_DB?: D1 }

const BASE: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cross-origin-resource-policy": "cross-origin",
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "content-length, content-range, etag",
  "referrer-policy": "no-referrer",
};

const plain = (status: number, text: string) => new Response(text, { status, headers: { ...BASE, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** "bytes=a-b", "bytes=a-" or "bytes=-n" (one range only) */
export function parseRange(h: string | null, size: number): { offset: number; length: number } | null | "bad" {
  if (!h) return null;
  const m = h.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return "bad";
  let a: number, b: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    a = Math.max(0, size - n);
    b = size - 1;
  } else {
    a = Number(m[1]);
    b = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!(a <= b && a < size)) return "bad";
  return { offset: a, length: b - a + 1 };
}

export async function handleFiles(req: Request, env: FilesEnv): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...BASE, "access-control-allow-methods": "GET, HEAD", "access-control-allow-headers": "range", "access-control-max-age": "86400" } });
  if (req.method !== "GET" && req.method !== "HEAD") return plain(405, "method not allowed");
  const m = new URL(req.url).pathname.match(/^\/c\/([a-z2-7]{12})\/([0-9a-f]{64})$/);
  if (!m || !env.SHARE_BUCKET || !env.SHARE_DB) return plain(404, "not found");
  const row = await env.SHARE_DB.prepare(
    `SELECT h.key, h.size FROM collections c JOIN versions v ON v.collection = c.id JOIN version_blobs vb ON vb.version = v.hash
     JOIN holdings h ON h.account_id = c.owner AND h.sha256 = vb.sha256 WHERE c.id = ?1 AND vb.sha256 = ?2 LIMIT 1`,
  ).bind(m[1], m[2]).first<{ key: string; size: number }>();
  if (!row) return plain(404, "not found (it may have been deleted by its owner)");
  const key = row.key;
  const head = { size: row.size };
  const range = parseRange(req.headers.get("range"), head.size);
  if (range === "bad") return new Response(null, { status: 416, headers: { ...BASE, "content-range": `bytes */${head.size}` } });
  const headers: Record<string, string> = {
    ...BASE,
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${m[2].slice(0, 16)}"`,
    "cache-control": "private, max-age=31536000, immutable",
    etag: `"${m[2]}"`,
    "accept-ranges": "bytes",
  };
  if (req.headers.get("if-none-match") === headers.etag) return new Response(null, { status: 304, headers });
  if (req.method === "HEAD") return new Response(null, { headers: { ...headers, "content-length": String(head.size) } });
  const o = await env.SHARE_BUCKET.get(key, range ? { range } : {});
  if (!o) return plain(404, "not found");
  if (range) return new Response(o.body, { status: 206, headers: { ...headers, "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`, "content-length": String(range.length) } });
  return new Response(o.body, { headers: { ...headers, "content-length": String(head.size) } });
}
