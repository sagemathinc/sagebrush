// sagebrush-desktop.js's entry (web/build.ts): the desktop app's own module, loaded by its pages only in the app
// (web/index.html desktopModule, web/board/page.ts): its workspace on disk and that workspace's self-test probe.
// Neither the site nor the CLI serves it; the app copies it (app/build-frontend.mjs).
export { diskWorkspace, beforeLeave, drainOnQuit } from "./disk-mirror";
export { persistProbe } from "./persist-probe";
export { grantsSync, keepGrants, reconcileGrants, startGrants } from "./grants-file";
