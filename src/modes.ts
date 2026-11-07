// The interpreter modes, as one table of plain data (design/rill.md §5.1).
//
// This module imports nothing and holds no mode implementation: names, the
// worker message's flags, which modes are translated to Python, and the
// Jupyter kernels' specs. Each consumer takes its own subset below, in its
// own order, because the copies were never uniform: the CLI's prompt has no
// Sage mode, a worker is told a mode by a flag (plain Python has none), and
// the kernels install in their own order. Hooks (translation, completion,
// is_incomplete) stay with each host, which imports them itself.

/** Every mode. */
export const MODE_NAMES = ["python", "sage", "magma", "matlab"] as const;
export type ModeName = (typeof MODE_NAMES)[number];

/** Whether s names a mode. */
export function isModeName(s: unknown): s is ModeName {
  return typeof s === "string" && (MODE_NAMES as readonly string[]).indexOf(s) >= 0;
}

/** The modes a notebook, a board and a board's code item can have, in their menus' order. */
export const DOCUMENT_MODES = ["python", "sage", "magma", "matlab"] as const;
export type DocumentMode = (typeof DOCUMENT_MODES)[number];

/** The modes other than plain Python, which a document names and a worker is told by a flag of the same name. */
export const FLAG_MODES = ["sage", "magma", "matlab"] as const;
export type FlagMode = (typeof FLAG_MODES)[number];

/** Whether s names a mode other than plain Python. */
export function isFlagMode(s: unknown): s is FlagMode {
  return s === "sage" || s === "magma" || s === "matlab";
}

/** A worker message's mode flags, every one present: { sage, magma, matlab }, true for the mode's own. */
export function modeFlags(mode: string | null | undefined): Record<FlagMode, boolean> {
  return { sage: mode === "sage", magma: mode === "magma", matlab: mode === "matlab" };
}

/** A worker message's mode flag, only when set: { sage: true }, { magma: true }, { matlab: true }, or {} for Python. */
export function modeFlag(mode: string | null | undefined): Partial<Record<FlagMode, true>> {
  return mode === "sage" ? { sage: true } : mode === "magma" ? { magma: true } : mode === "matlab" ? { matlab: true } : {};
}

/** The mode a worker message's flags name (the first set, in FLAG_MODES' order), or null for plain Python. */
export function modeOfFlags(m: { sage?: unknown; magma?: unknown; matlab?: unknown }): FlagMode | null {
  return m.sage ? "sage" : m.magma ? "magma" : m.matlab ? "matlab" : null;
}

/** The modes whose code is translated to Python (src/magma.ts, src/matlab.ts). Their source has no IPython syntax
 * or magics, and Python-level renames and analysis do not apply to it as written. */
export const TRANSLATED_MODES = ["magma", "matlab"] as const;
export type TranslatedMode = (typeof TRANSLATED_MODES)[number];

/** Whether a mode's code is translated to Python. */
export function isTranslated(mode: string | null | undefined): mode is TranslatedMode {
  return mode === "magma" || mode === "matlab";
}

/** The CLI's interactive prompt modes (src/cli.ts): Sage mode's prompt is Python's with Sage's preparser. */
export const REPL_MODES = ["python", "magma", "matlab"] as const;
export type ReplMode = (typeof REPL_MODES)[number];

/** The Jupyter kernels (src/kernel.ts), in the order `--mode all` installs them. */
export const KERNEL_MODES = ["sage", "python", "magma", "matlab"] as const;
export type KernelMode = (typeof KERNEL_MODES)[number];

/** Each kernel's spec: its directory, display name, language and language_info. */
export const KERNEL_SPECS: Record<KernelMode, { dir: string; display: string; language: string; info: any }> = {
  sage: {
    dir: "sagebrush",
    display: "Sagebrush (Sage)",
    language: "sage",
    info: { name: "sage", version: "3.14", mimetype: "text/x-python", file_extension: ".sage", codemirror_mode: { name: "ipython", version: 3 }, pygments_lexer: "ipython3" },
  },
  python: {
    dir: "sagebrush-python",
    display: "Sagebrush (Python)",
    language: "python",
    info: { name: "python", version: "3.14", mimetype: "text/x-python", file_extension: ".py", codemirror_mode: { name: "ipython", version: 3 }, pygments_lexer: "ipython3", nbconvert_exporter: "python" },
  },
  magma: {
    dir: "sagebrush-magma",
    display: "Sagebrush (Magma)",
    language: "magma",
    info: { name: "magma", version: "", mimetype: "text/x-magma", file_extension: ".m" },
  },
  matlab: {
    dir: "sagebrush-matlab",
    display: "Sagebrush (MATLAB)",
    language: "matlab",
    // (as the MathWorks kernel describes MATLAB: Jupyter's front ends highlight it as Octave)
    info: { name: "matlab", version: "", mimetype: "text/x-matlab", file_extension: ".m", codemirror_mode: "octave", pygments_lexer: "matlab" },
  },
};
