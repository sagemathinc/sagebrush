// Page-order scoping's renames for one cell, beside its code (src/rename.ts
// renameRedefinitions, src/notebook-reactive.ts): the closed grammar each
// translator that applies them checks first (src/magma.ts, src/matlab.ts).
/** A page-order map refused: nothing of the cell is translated. */
export class PageOrderError extends Error {
  constructor(why: string) {
    super(`the page-order map was refused (${why})`);
    this.name = "PageOrderError";
  }
}

/**
 * Page-order scoping's renames for one cell (src/rename.ts renameInCell),
 * passed by the host beside the code, never read from it: NAME -> { to,
 * before? }.  Every NAME of the cell's is TO (loop variables and parameters
 * aside); with `before`, a redefining cell whose code needs the earlier value
 * starts TO as a copy of BEFORE.  A closed grammar, the renamer's own forms:
 * NAME a Python name, TO NAME + U+02B9 + digits, BEFORE NAME or such a form of
 * it; anything else is refused before the cell is translated.
 */
export type PageOrder = Readonly<Record<string, Readonly<{ to: string; before?: string }>>>;
const PO_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/, PO_SCOPED = /^([A-Za-z_][A-Za-z0-9_]*)\u02b9[1-9][0-9]{0,5}$/;
export function checkPageOrder(po: unknown): Map<string, { to: string; mode: "definition" | "all"; before: string }> {
  const out = new Map<string, { to: string; mode: "definition" | "all"; before: string }>();
  if (po === undefined || po === null) return out;
  const plain = (o: unknown): o is Record<string, unknown> => typeof o === "object" && o !== null && !Array.isArray(o) && [Object.prototype, null].includes(Object.getPrototypeOf(o));
  if (!plain(po)) throw new PageOrderError("not a plain object");
  const names = Object.keys(po);
  if (names.length > 1024) throw new PageOrderError("too many entries");
  for (const name of names) {
    const e = po[name];
    if (!PO_NAME.test(name) || !plain(e)) throw new PageOrderError(`bad entry for ${JSON.stringify(name).slice(0, 40)}`);
    const keys = Object.keys(e);
    if (keys.some((k) => k !== "to" && k !== "before")) throw new PageOrderError(`bad entry for ${JSON.stringify(name).slice(0, 40)}`);
    const { to, before } = e as { to?: unknown; before?: unknown };
    if (typeof to !== "string" || PO_SCOPED.exec(to)?.[1] !== name) throw new PageOrderError(`bad entry for ${JSON.stringify(name).slice(0, 40)}`);
    if (before !== undefined && (typeof before !== "string" || before === to || !(before === name || PO_SCOPED.exec(before)?.[1] === name))) throw new PageOrderError(`bad entry for ${JSON.stringify(name).slice(0, 40)}`);
    out.set(name, { to, mode: before !== undefined ? "definition" : "all", before: (before as string | undefined) ?? name });
  }
  return out;
}

/** MATLAB code that names variables at run time: no page-order renames (src/rename.ts refuses them, src/matlab.ts too). */
export const MATLAB_DYNAMIC_NAMES = /\b(clear\w*|eval\w*|feval|run|exist|who|whos|load|save|assignin|inputname|global)\b/;
