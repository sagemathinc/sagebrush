// A notebook in the form the notebook keeps it, with no dependency, so the workspace and the page's focus takeover can
// both compare documents by value: canonical JSON, a cell's own form (cellForm), and a whole document's value
// (docValue).  web/workspace/notebook-edit.ts gives the same canonical and cellForm to agents' edits by cell.

/** JSON with every object's keys in order (undefined left out), so two pages compare a document alike. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
/** A cell in the form the notebook keeps it (web/notebook/notebook.js snapshot): what a save of it writes, whatever
 * form it was stored in (a code cell's type implicit, its count as text, empty fields left out).  Hashed in this form,
 * so a save that only re-forms a cell (the pane's first save of a document written elsewhere) isn't a change. */
export function cellForm(c: any): Record<string, unknown> {
  const type = c?.type ?? "code";
  const out: Record<string, unknown> = { id: c?.id, ...(type === "code" ? {} : { type }), code: c?.code ?? "" };
  if (type === "code") {
    out.outputs = Array.isArray(c?.outputs) ? c.outputs : [];
    out.n = c?.n === null || c?.n === undefined ? null : String(c.n);
    if (c?.ms !== null && c?.ms !== undefined) out.ms = c.ms;
  }
  if (type === "markdown" && c?.attachments) out.attachments = c.attachments;
  if (c?.metadata) out.metadata = c.metadata;
  return out;
}
/** What a store keeps beside a notebook's content, for itself (its record's envelope), and its name (its path's). */
export const ENVELOPE = ["id", "rev", "updated", "baseRev", "name", "j", "hash", "unjournaled", "at", "from", "proof"];
/** A whole document's value: every field but the envelope (its language too unless `withMode` is false), each cell
 * whole in the notebook's form: equal for a document and the record a save of it leaves. */
export function docValue(d: any, withMode = true): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d ?? {})) if (!ENVELOPE.includes(k) && k !== "cells" && (withMode || k !== "mode")) out[k] = v;
  out.cells = (Array.isArray(d?.cells) ? d.cells : []).map(cellForm);
  return canonical(out);
}
