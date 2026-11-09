// ci: web-sync.3 order=11 chrome env=SHARE_DIALOG_PART=1 env=SHARE_DIALOG_BIG=0
// ci: web-sync.7 order=11 chrome env=SHARE_DIALOG_PART=2 env=SHARE_DIALOG_BIG=0
// web/share/test-share-dialog.mjs (MIT) run against this directory's share server (MS-RSL): see run-mit-suite.mjs.
// (SHARE_DIALOG_BIG=0, as the cloud repository's CI ran it: the 10,000-file scale case tests only the page's code,
// which core's own run of the suite covers.)
//   SHARE_DIALOG_PART=1 CHROME=google-chrome node web/cloud/share/test-share-dialog.mjs
import { runOnHosted } from "./run-mit-suite.mjs";

runOnHosted("../../share/test-share-dialog.mjs", /^all \d+ passed$/);
