// What can be downloaded for offline use, and how big it is (B8, plan-b8-offline r3.4 §2-§3).
//
// The service worker keeps LAZY files the first time they are used (web/sw.js).  This module turns that list into the
// inventory the page shows ("Storage -> Offline") and the service worker's "download all" acts on: a few items, each a
// set of library groups or a rule, with its file count and byte totals.  It carries no paths and no hashes: the
// service worker resolves an item to paths from its own trusted LAZY list, so the inventory can't name a file that
// isn't the build's.
//
// The build refuses a catalog over its caps (§3): the service worker repeats the same checks at runtime.
export const OFFLINE_CAPS = Object.freeze({
  files: 600,
  stored: 64 * 1024 * 1024,
  transfer: 16 * 1024 * 1024,
  maxEntry: 16 * 1024 * 1024,
  inventoryRaw: 8192,
  inventoryGzip: 3072,
});

export type OfflineItem = {
  id: string;
  kind: "engine" | "mode" | "package" | "modules" | "docs" | "myst" | "tzdata";
  title: string;
  /** library groups (web/lib-chunks.mts), or a rule naming non-library files */
  groups?: string[];
  rule?: "engine" | "docs" | "myst" | "tzdata";
  /** other items this one needs to be useful offline (shown, never fetched automatically) */
  needs?: string[];
  /** an item the page can't use yet: counted by every control and cap here, but the service worker drops it when it
   * loads the inventory, so nothing lists it, "download all" never fetches it and no "new item" names it (web/sw.js) */
  hidden?: true;
  files: number;
  /** decoded bytes on this device (exact) */
  stored: number;
  /** compressed bytes, the build's estimate of the download (never shown as traffic) */
  transfer: number;
};
export type OfflineInventory = {
  format: "sagebrush-offline-1";
  items: OfflineItem[];
  totals: { files: number; stored: number; transfer: number; maxEntry: number };
};

// (needs: every item a mode's start fetches groups of (manifest.modes), "modules" for its files' own mod- groups:
// web/lib-chunks.mts MODE_FAMILIES)
const MODES: { id: string; title: string; prefix: string; exact?: string; needs?: string[]; hidden?: true }[] = [
  { id: "python", title: "Python", prefix: "", exact: "core" },
  { id: "scientific", title: "Scientific Python (numpy, matplotlib, k3d, ipywidgets)", prefix: "", exact: "sci", needs: ["python", "modules"] },
  { id: "sage", title: "Sage", prefix: "sage", needs: ["python", "modules"] },
  { id: "matlab", title: "MATLAB", prefix: "matlab", needs: ["python", "scientific", "modules"] },
  { id: "magma", title: "Magma", prefix: "magma", needs: ["python", "sage", "modules"] },
  // (every Rill group is named rill-*, so this item owns them all: design/rill.md §6.1. Hidden until the page can
  // run Rill, A2's worker, which removes the flag: @sagebrush's ruling on #847, Nov 8)
  { id: "rill", title: "R (Rill)", prefix: "rill", needs: ["python", "modules"], hidden: true },
  // (every Sprig group is named sprig-*, so this item owns them all: design/sprig-mvp.md §6.1.  Hidden until the page
  // can run Sprig, S7's worker)
  { id: "sprig", title: "Sprig", prefix: "sprig", needs: ["python", "sage", "modules"], hidden: true },
];

/** whether the item `id` holds or needs the item `other` (a mode's start may fetch only those: web/build.ts checks) */
export function itemCovers(id: string, other: string): boolean {
  return other === id || !!MODES.find((m) => m.id === id)?.needs?.includes(other);
}

/** a library group's item id, by rule; a group no rule covers fails the build (each new group is placed on purpose) */
export function itemOfGroup(group: string): string {
  if (group.startsWith("pkg-")) return group;
  if (group.startsWith("mod-")) return "modules";
  for (const m of MODES) {
    if (m.exact !== undefined ? group === m.exact : group === m.prefix || group.startsWith(m.prefix + "-")) return m.id;
  }
  throw new Error(`offline inventory: the library group ${JSON.stringify(group)} belongs to no item (web/offline-inventory.mts)`);
}

const CHUNK = /^lib\/([a-z0-9][a-z0-9-]*)\.(?:src|pre)\.[0-9a-f]{16}\.json$/;
/** the rule or group of a LAZY path */
function classify(path: string): { rule: "engine" | "docs" | "tzdata" } | { group: string } {
  if (/^sagebrush-engine\.wasm\?h=[0-9a-f]+$/.test(path)) return { rule: "engine" };
  if (/^docs-index(?:-[a-z]+)?\.json$/.test(path)) return { rule: "docs" };
  if (path === "sagebrush-myst.js") return { rule: "myst" };
  if (path.startsWith("lib/tzdata/")) return { rule: "tzdata" };
  const m = CHUNK.exec(path);
  if (m) return { group: m[1] };
  throw new Error(`offline inventory: the LAZY path ${JSON.stringify(path)} belongs to no item`);
}

/**
 * The inventory of `lazy` (every path once), given each path's stored and transfer bytes and the packages' titles
 * (package item id "pkg-<dir>" -> title).  Throws when an item would be empty, a path is in two items or none, or a
 * total is over its cap.
 */
export function offlineInventory(lazy: string[], stored: Map<string, number>, transfer: Map<string, number>, packageTitles: Record<string, string> = {}): OfflineInventory {
  const byItem = new Map<string, string[]>();
  const groupsOf = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (const p of lazy) {
    if (seen.has(p)) throw new Error(`offline inventory: ${p} is in LAZY twice`);
    seen.add(p);
    if (!stored.has(p) || !transfer.has(p)) throw new Error(`offline inventory: no size for ${p}`);
    const c = classify(p);
    const id = "rule" in c ? c.rule : itemOfGroup(c.group);
    if (!byItem.has(id)) byItem.set(id, []);
    byItem.get(id)!.push(p);
    if ("group" in c) {
      if (!groupsOf.has(id)) groupsOf.set(id, new Set());
      groupsOf.get(id)!.add(c.group);
    }
  }
  const sum = (ps: string[], m: Map<string, number>) => ps.reduce((t, p) => t + m.get(p)!, 0);
  const items: OfflineItem[] = [];
  const add = (it: Omit<OfflineItem, "files" | "stored" | "transfer">) => {
    const ps = byItem.get(it.id);
    if (!ps) return;
    items.push({ ...it, files: ps.length, stored: sum(ps, stored), transfer: sum(ps, transfer) });
    byItem.delete(it.id);
  };
  add({ id: "engine", kind: "engine", title: "The Sagebrush engine", rule: "engine" });
  for (const m of MODES) add({ id: m.id, kind: "mode", title: m.title, groups: [...(groupsOf.get(m.id) ?? [])].sort(), ...(m.needs ? { needs: m.needs } : {}), ...(m.hidden ? { hidden: true as const } : {}) });
  for (const id of [...byItem.keys()].filter((k) => k.startsWith("pkg-")).sort()) add({ id, kind: "package", title: packageTitles[id] ?? id.slice(4), groups: [...groupsOf.get(id)!].sort() });
  add({ id: "modules", kind: "modules", title: "Other Python modules", groups: [...(groupsOf.get("modules") ?? [])].sort() });
  add({ id: "docs", kind: "docs", title: "Documentation search", rule: "docs" });
  add({ id: "myst", kind: "myst", title: "MyST documents", rule: "myst" });
  add({ id: "tzdata", kind: "tzdata", title: "Time zones", rule: "tzdata" });
  if (byItem.size) throw new Error(`offline inventory: unplaced items ${[...byItem.keys()].join(", ")}`);
  const totals = {
    files: lazy.length,
    stored: sum(lazy, stored),
    transfer: sum(lazy, transfer),
    maxEntry: Math.max(0, ...lazy.map((p) => stored.get(p)!)),
  };
  const over: string[] = [];
  if (totals.files > OFFLINE_CAPS.files) over.push(`${totals.files} files > ${OFFLINE_CAPS.files}`);
  if (totals.stored > OFFLINE_CAPS.stored) over.push(`${totals.stored} stored bytes > ${OFFLINE_CAPS.stored}`);
  if (totals.transfer > OFFLINE_CAPS.transfer) over.push(`${totals.transfer} transfer bytes > ${OFFLINE_CAPS.transfer}`);
  if (totals.maxEntry > OFFLINE_CAPS.maxEntry) over.push(`an entry of ${totals.maxEntry} bytes > ${OFFLINE_CAPS.maxEntry}`);
  if (over.length) throw new Error(`offline inventory: the catalog is over its caps (plan-b8-offline §3): ${over.join("; ")}`);
  return { format: "sagebrush-offline-1", items, totals };
}

/** the inventory's bytes, and the caps on them (raw, gzip-9); throws when over */
export function inventoryBytes(inv: OfflineInventory, gzip: (b: Uint8Array) => Uint8Array): Uint8Array {
  const raw = new TextEncoder().encode(JSON.stringify(inv) + "\n");
  const gz = gzip(raw).length;
  if (raw.length > OFFLINE_CAPS.inventoryRaw || gz > OFFLINE_CAPS.inventoryGzip) {
    throw new Error(`offline inventory: ${raw.length} B raw / ${gz} B gzip, over its caps ${OFFLINE_CAPS.inventoryRaw} / ${OFFLINE_CAPS.inventoryGzip}`);
  }
  return raw;
}
