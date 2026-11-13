// A published notebook's versions, as the Share dialog says them: how many times it was published and when last, and
// what changed since (its cells, added, removed or edited, compared by id, else by position).  Read from the share's
// own records only: the versions list (signed in, the owner's) and the latest version's notebook file.

export interface Published {
  /** how many versions, and the latest's time (ms) */
  count: number;
  latestMs: number;
  /** what changed since the latest version, in a few words, or "" when nothing did; null: couldn't tell */
  changed: string | null;
}

type Cell = { id?: string; cell_type?: string; source?: string | string[] };
const text = (c: Cell) => (Array.isArray(c.source) ? c.source.join("") : c.source ?? "");
const cellsOf = (bytes: ArrayBuffer | Uint8Array): Cell[] | null => {
  try {
    const nb = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(nb?.cells) ? nb.cells : null;
  } catch {
    return null;
  }
};
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** the cells added, removed and edited from `before` to `after`, in a few words ("" when none) */
export function cellChanges(before: Cell[], after: Cell[]): string {
  const keyed = before.every((c) => c.id) && after.every((c) => c.id);
  const key = (c: Cell, i: number) => (keyed ? c.id! : String(i));
  const old = new Map(before.map((c, i) => [key(c, i), c]));
  let edited = 0, added = 0;
  const seen = new Set<string>();
  after.forEach((c, i) => {
    const k = key(c, i), o = old.get(k);
    seen.add(k);
    if (!o) added++;
    else if (text(o) !== text(c) || (o.cell_type ?? "") !== (c.cell_type ?? "")) edited++;
  });
  const removed = [...old.keys()].filter((k) => !seen.has(k)).length;
  const parts = [edited && `${plural(edited, "cell")} edited`, added && `${added} added`, removed && `${removed} removed`].filter(Boolean);
  if (!parts.length) return "";
  // ("2 cells edited, 1 added": the noun once, on the first part)
  if (!edited) parts[0] = `${plural(added || removed, "cell")} ${added ? "added" : "removed"}`;
  return parts.join(", ");
}

/** share `id`'s versions and what changed in the notebook `nb` (its path in the share, and its bytes now) since the
 * latest; null if the share can't be read (signed out, another account's, offline) */
export async function published(id: string, nb: { path: string; data: Uint8Array }): Promise<Published | null> {
  const get = (u: string) => fetch(u, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null), () => null);
  const [vs, c] = await Promise.all([get(`/api/share/collections/${id}/versions`), get(`/api/share/c/${id}`)]);
  const list: { created: number }[] | undefined = vs?.versions;
  if (!Array.isArray(list) || !list.length) return null;
  // (the server keeps seconds)
  const out: Published = { count: list.length, latestMs: 1000 * Math.max(...list.map((v) => v.created)), changed: null };
  const f = c?.manifest?.files?.find((x: { path: string }) => x.path === nb.path);
  if (!f) return out;
  if (hex(await crypto.subtle.digest("SHA-256", nb.data as BufferSource)) === f.sha256) return { ...out, changed: "" };
  try {
    const r = await fetch(new URL(`/c/${c.id}/${f.sha256}`, c.files_origin).href);
    const before = r.ok ? cellsOf(await r.arrayBuffer()) : null, after = cellsOf(nb.data);
    out.changed = before && after ? cellChanges(before, after) || "only its outputs or settings" : null;
  } catch {}
  return out;
}

/** "Nov 13, 9:02 AM" */
export const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** a link with a Copy button beside it (`label`: the link's text, else the address itself) */
export function linkWithCopy(url: string, label?: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "pubcopy";
  const a = Object.assign(document.createElement("a"), { href: url, target: "_blank", rel: "noopener", textContent: label ?? url.replace(/^https?:\/\//, "") });
  const b = Object.assign(document.createElement("button"), { type: "button", textContent: "Copy" });
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      b.textContent = "Copied";
    } catch {
      b.textContent = "Couldn't copy";
    }
    setTimeout(() => (b.textContent = "Copy"), 2000);
  });
  span.append(a, " ", b);
  return span;
}
