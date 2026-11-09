// ci: web-sync.2 order=51 chrome
// web/share/test-share-ui.mjs (MIT) run against this directory's share server (MS-RSL): see run-mit-suite.mjs.
//   CHROME=google-chrome node web/cloud/share/test-share-ui.mjs
import { runOnHosted } from "./run-mit-suite.mjs";

runOnHosted("../../share/test-share-ui.mjs", /^all passed$/);
