// ci: none (imported by other suites, not one itself: web/test-board.mjs, web/board/test-code.mjs, -export.mjs, -images.mjs)
// What the board suites' page-error checks expect on the static test server: a load error the page logs is a failure,
// except a 404 for exactly the sync status (GET /api/sync/v1/status).  The board page asks it on any origin outside
// the hosted ones (the notebook switch's gate, web/workspace/doc-sync-switch.ts); a static host has no sync server, so
// it answers 404 and the page leaves notebook sync off, as it should.  Anything else there still fails: another status
// (a 500), or a 404 for any other path (a sibling, a longer path).

/** Whether a logged load error (a Log.entryAdded entry: its text and URL) is the static host's expected 404 for the
 * sync status, and nothing else. */
export function expectedLoadError(entry) {
  if (!/status of 404\b/.test(entry?.text ?? "")) return false;
  try {
    return new URL(entry.url).pathname === "/api/sync/v1/status";
  } catch {
    return false;
  }
}
