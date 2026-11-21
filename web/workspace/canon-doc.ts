// The canonical bytes of a notebook or a data file, for an agent's branch (branch-canon.ts's versions; see there):
// apart from branch-canon.ts so a page without boards (the notebook page, where runs are) has them without the board's
// canonical text, and without branch-rules.ts (whose branchCopy calls this for its canon-1 bytes).  branch-canon.ts calls
// these too, so every caller has one function.

export type Canon = 1 | 2;

const enc = new TextEncoder();

/** `v` with every object's keys in sorted order (arrays kept in order), for JSON.stringify. */
export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object" && !(v instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** The canonical bytes of a notebook or a data file whose content is `content`, under `version`. */
export function docCanonBytes(kind: "notebook" | "file", content: any, version: Canon): Uint8Array {
  if (kind === "file") return content instanceof Uint8Array ? content : enc.encode(String(content ?? ""));
  const d = content ?? {};
  const cells = Array.isArray(d.cells) ? d.cells : [];
  // (canon 1: git_branch's first form, the cells' type and code in that order, no mode)
  if (version === 1) return enc.encode(JSON.stringify({ cells: cells.map((c: any) => ({ type: c?.type ?? "code", code: String(c?.code ?? "") })) }));
  return enc.encode(JSON.stringify(sortKeys({ mode: d.mode ?? null, cells: cells.map((c: any) => ({ type: c?.type ?? "code", code: String(c?.code ?? "") })) })));
}

/** The git blob id of `bytes` (branch-store.ts's objectId("blob", bytes)): SHA-1 of "blob <length>\0" + bytes. */
export async function blobOid(bytes: Uint8Array): Promise<string> {
  const head = enc.encode(`blob ${bytes.length}\0`), all = new Uint8Array(head.length + bytes.length);
  all.set(head); all.set(bytes, head.length);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", all))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
