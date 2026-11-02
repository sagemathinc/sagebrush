// The Share dialog's file list as a model (share-ux-plan r2 §1, §4): which
// files are checked, which the user has touched, why a file is suggested,
// shift ranges, Select all/none, the summary and the bounds.  No DOM: the
// dialog (dialog.ts) draws the rows it shows from this, so a list of 100,000
// files is never 100,000 nodes, and the rules here are tested under node
// (test-selection.mjs).
//
// The rules:
//   - one stable order: the notebook first, then the files by path; nothing
//     ever reorders it, so a row never moves under the pointer (UI-2);
//   - the notebook is always checked and can't be changed;
//   - anything the user does to a box (a click, a key, every member of a
//     shift range, Select all/none) makes it touched, and the analysis never
//     changes a touched box (CORR-SHAREUX-3, UI-7);
//   - a suggestion only ever checks a box (never unchecks one), and only an
//     untouched one, of the current generation.
import type { Reason } from "../deps/file-deps";

export type RowState = "analyzing" | "not-analyzed" | "done";
export interface Row {
  path: string;
  size?: number;
  fid?: string;
  rev?: number;
  notebook?: boolean;
  checked: boolean;
  touched: boolean;
  reason?: Reason;
}
export interface Bounds {
  /** the share API's MAX_FILES */
  maxFiles: number;
  /** the plan's largest file, if known */
  maxFileBytes?: number;
  /** what the account may still store, if known */
  bytesLeft?: number;
}

const byPath = (a: Row, b: Row) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export class Selection {
  readonly rows: Row[];
  private index = new Map<string, number>();
  private anchor: number | null = null;
  /** the analysis's state, shown on unchecked, unsuggested rows */
  state: RowState = "analyzing";
  /** the generation this selection belongs to: suggestions for another are ignored */
  readonly gen: number;
  frozen = false;

  constructor(gen: number, notebook: { path: string; size?: number }, files: { path: string; size?: number; fid?: string; rev?: number }[]) {
    this.gen = gen;
    const rest = files.filter((f) => f.path !== notebook.path).map((f) => ({ ...f, checked: false, touched: false }) as Row).sort(byPath);
    this.rows = [{ path: notebook.path, size: notebook.size, notebook: true, checked: true, touched: true }, ...rest];
    this.rows.forEach((r, i) => this.index.set(r.path, i));
  }

  row(path: string): Row | undefined {
    const i = this.index.get(path);
    return i === undefined ? undefined : this.rows[i];
  }

  /** The analysis suggests `path`: checked, if untouched, of this generation, and not frozen. True if it changed. */
  suggest(gen: number, path: string, reason: Reason): boolean {
    if (gen !== this.gen || this.frozen) return false;
    const r = this.row(path);
    if (!r || r.notebook || r.touched) return false;
    if (!r.reason) r.reason = reason;
    if (r.checked) return false;
    r.checked = true;
    return true;
  }

  /** A click or a key on row `i`; with shift, every row from the anchor to `i` takes `i`'s new state. Returns the rows changed. */
  toggle(i: number, shift = false): number[] {
    if (this.frozen) return [];
    const r = this.rows[i];
    if (!r || r.notebook) return [];
    const value = !r.checked;
    let from = i, to = i;
    if (shift && this.anchor !== null) [from, to] = this.anchor < i ? [this.anchor, i] : [i, this.anchor];
    const changed: number[] = [];
    for (let k = from; k <= to; k++) {
      const x = this.rows[k];
      if (x.notebook) continue;
      x.touched = true;
      if (x.checked !== value) {
        x.checked = value;
        changed.push(k);
      }
    }
    this.anchor = i;
    return changed;
  }

  /** Select all or none: every box but the notebook's, each then touched. */
  all(value: boolean): void {
    if (this.frozen) return;
    for (const r of this.rows) {
      if (r.notebook) continue;
      r.checked = value;
      r.touched = true;
    }
  }

  /** What is checked, as the summary line says it, and whether a bound stops the upload. */
  summary(bounds: Bounds): { files: number; of: number; bytes: number; sizesKnown: boolean; over: string | null } {
    let files = 0, bytes = 0, sizesKnown = true;
    let biggest: Row | null = null;
    for (const r of this.rows) {
      if (!r.checked) continue;
      files++;
      if (r.size === undefined) sizesKnown = false;
      else {
        bytes += r.size;
        // (the notebook too: the share API's per-file limit applies to it, CORR-172-ASTRA-3)
        if (!biggest || r.size > (biggest.size ?? 0)) biggest = r;
      }
    }
    let over: string | null = null;
    if (files > bounds.maxFiles) over = `at most ${bounds.maxFiles.toLocaleString("en-US")} files can be shared (${(files - bounds.maxFiles).toLocaleString("en-US")} too many)`;
    else if (bounds.maxFileBytes !== undefined && biggest && (biggest.size ?? 0) > bounds.maxFileBytes) over = `${biggest.path} is larger than your plan's largest file`;
    else if (bounds.bytesLeft !== undefined && sizesKnown && bytes > bounds.bytesLeft) over = `more than your storage has left`;
    return { files, of: this.rows.length, bytes, sizesKnown, over };
  }

  /** The upload's immutable snapshot: from here on, nothing changes the boxes. */
  snapshot(): readonly { path: string; size?: number; fid?: string; notebook?: boolean }[] {
    this.frozen = true;
    return Object.freeze(this.rows.filter((r) => r.checked).map((r) => Object.freeze({ path: r.path, size: r.size, fid: r.fid, ...(r.notebook ? { notebook: true } : {}) })));
  }

  /** After the upload (success or failure): the boxes work again. */
  thaw(): void {
    this.frozen = false;
  }
}

/** A reason, as the row's second line says it (UI-5, UI-6: cells by position from the top). */
export function reasonText(r: Reason): string {
  const nth = (n: number) => {
    const k = n + 1, s = k % 100 >= 11 && k % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][k % 10] ?? "th";
    return `the ${k}${s} cell`;
  };
  const by = (p: string) => p.replace(/^\/+/, "");
  if ("cell" in r) {
    switch (r.kind) {
      case "read":
        return `read when ${nth(r.cell)} last ran`;
      case "opened":
        return `opened in ${nth(r.cell)}`;
      case "named":
        return `named in ${nth(r.cell)}`;
      case "linked":
        return `linked in ${nth(r.cell)}`;
      case "imported":
        return `imported in ${nth(r.cell)}`;
    }
  }
  return `${r.kind} by ${by((r as { by: string }).by)}`.replace(/^opened by/, "opened in").replace(/^named by/, "named in");
}
