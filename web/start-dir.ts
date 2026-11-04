// A notebook's folder as the page gives it: an absolute path of at most 1024 characters, its segments neither empty
// nor "." nor "..", none holding a control character (U+0000-U+001F or DEL U+007F, the workspace's own rule:
// web/workspace/paths.ts CONTROL), and not the runtime's own (/$pyjs): else null, and the session stays in "/". The
// files here are the workspace's (and the runtime's library under /$pyjs): no other place to reach.
export function startDirOf(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 1024 || !v.startsWith("/")) return null;
  if (v === "/") return "/";
  const segs = v.slice(1).split("/");
  if (segs.some((s) => s === "" || s === "." || s === ".." || /[\u0000-\u001f\u007f]/.test(s))) return null;
  if (segs[0].startsWith("$")) return null;
  return v;
}
