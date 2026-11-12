// SHA-256 of bytes, lower-case hex: what web/notebook/stores.js's bytesHash computes wherever crypto.subtle exists,
// which the branch store already requires (its object ids are SHA-1, by crypto.subtle). Here, typed, so the branch
// modules need not load stores.js (its own module, checked apart).

export async function sha256Hex(data: Uint8Array): Promise<string> {
  // (the bytes here are never a SharedArrayBuffer's view: as BufferSource, without a copy)
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
  let out = "";
  for (const b of d) out += b.toString(16).padStart(2, "0");
  return out;
}
