// The files the code page opens, by extension (1a: William, Nov 5, "so users can easily browse these .py (etc) files"),
// and their language. Its own module, with nothing else, so the page's boot hook (boot.ts) carries no highlighter.
import { nameOf, splitExt } from "../workspace/paths";

export type Lang = "python" | "sage" | "matlab" | "magma" | "js" | "json" | "text";
export const CODE_LANGS: Record<string, Lang> = { ".py": "python", ".sage": "sage", ".m": "matlab", ".mag": "magma", ".js": "js", ".json": "json", ".txt": "text" };

/** A file's language by its name, or null if the code page doesn't open it. */
export function langOf(path: string): Lang | null {
  const ext = splitExt(nameOf(path))[1].toLowerCase();
  return Object.hasOwn(CODE_LANGS, ext) ? CODE_LANGS[ext] : null;
}
