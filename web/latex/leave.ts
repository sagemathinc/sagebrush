// Leaving the file shown (page.ts: a switch to another file, Back or Forward to another file's entry): the editor shown
// settles first (astra U8-DURABLE-CLOSE-1): its latest edit written, or durable in its draft. The editor is held
// read-only from the start of the wait, so the edit settled and asked about is the last one: no newer edit can come
// between that and the close (a single, frozen close). Only the newest intent goes on: a switch asked for meanwhile, or
// a return to the file shown (intent(), astra U8-SWITCH-2), makes this one do nothing (null), and the hold is let go
// unless a newer switch holds it.
// (the editor shown changing under the wait with no newer intent: the mount's placeholder replaced by the file's
//  editor once its read is done. That editor is the one to settle, so the wait starts again on it; the request isn't
//  dropped (astra, grader H10))
// Apart from page.ts so its order can be tested with fake editors (test-latex-autosave.mjs; grader H10b, R2, R3).

/** The editor shown, as leaving sees it: settled, asked whether anything is still unsaved, held read-only. */
export interface Leavable {
  settle(): Promise<boolean>;
  dirty(): boolean;
  hold(on: boolean): void;
}

/** `current`: the editor shown now (or none). `ask`: the question, when a write failed or the edit is in neither the
 * file nor a durable draft (`lost`: not even in a draft): true to leave anyway. */
export function leaver(current: () => Leavable | null, ask: (lost: boolean) => boolean) {
  let leaving = 0, heldBy = 0;
  const intent = () => ++leaving;
  const leaveOk = async (): Promise<boolean | null> => {
    const n = intent();
    for (;;) {
      const cur = current();
      heldBy = n; cur?.hold(true);
      const release = () => { if (heldBy === n) { heldBy = 0; cur?.hold(false); } };
      const settled = await (cur?.settle() ?? Promise.resolve(true));
      if (n !== leaving) { release(); return null; }
      if (cur !== current()) { release(); continue; }
      // (asked only when a write failed or the edit is in neither the file nor a durable draft: U8, never otherwise)
      const ok = (settled && !cur?.dirty()) || ask(!settled);
      if (!ok) release();
      return ok;
    }
  };
  return { intent, leaveOk };
}
