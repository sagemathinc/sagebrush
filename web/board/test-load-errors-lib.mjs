// ci: none (imported by other suites, not one itself: web/test-board.mjs, web/board/test-code.mjs, -export.mjs, -images.mjs)
// What the board suites' page-error checks expect on the static test server: a load error the page logs is a failure,
// except a 404 for exactly one of two paths the page asks of any site, which a static host doesn't have:
//   - the sync status (GET /api/sync/v1/status): the board page asks it on any origin outside the hosted ones (the
//     notebook switch's gate, web/workspace/doc-sync-switch.ts), and a 404 leaves notebook sync off, as it should;
//   - the site's account (/api/share/me): a server without accounts answers 404, and the top bar shows no account.
// Anything else there still fails: another status (a 500), or a 404 for any other path (a sibling, a longer path).

const EXPECTED_404 = new Set(["/api/sync/v1/status", "/api/share/me"]);

/** Whether a logged load error (a Log.entryAdded entry: its text and URL) is the static host's expected 404 for one of
 * those two paths exactly, and nothing else. */
export function expectedLoadError(entry) {
  if (!/status of 404\b/.test(entry?.text ?? "")) return false;
  try {
    return EXPECTED_404.has(new URL(entry.url).pathname);
  } catch {
    return false;
  }
}
