// POSIX path functions used by the import machinery.
export function normalize(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const s of p.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else if (s !== ".." || !abs) out.push(s);
  }
  return (abs ? "/" : "") + out.join("/") || (abs ? "/" : ".");
}
export const join = (...parts: string[]) => normalize(parts.filter(Boolean).join("/"));
export const resolve = (...parts: string[]) => {
  let p = "";
  for (const q of parts) p = q.startsWith("/") ? q : p + "/" + q;
  return normalize(p.startsWith("/") ? p : "/" + p);
};
export const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) || "/" : ".");
export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const sep = "/";
export default { normalize, join, resolve, dirname, basename, sep };
