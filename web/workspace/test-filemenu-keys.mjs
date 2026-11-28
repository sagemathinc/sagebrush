// ci: web-runner order=294 runner=bun
// The File menu's keys (web/workspace/filemenu.ts fileMenuKey): Ctrl+Alt+N a new notebook, Ctrl+O Open…, and, for the
// desktop app's File ▸ New window (#1541), Ctrl+Shift+N (Cmd on a Mac); none of them taken for another, and nothing
// else taken at all (a browser's own Ctrl+Shift+N is left alone by the pages, which find no New window item there).
//   bun web/workspace/test-filemenu-keys.mjs
import { fileMenuKey, FILE_KEYS } from "./filemenu.ts";

let fails = 0, checks = 0;
const ok = (c, what) => { checks++; console.log((c ? "ok   " : "FAIL ") + what); if (!c) fails++; };
const key = (k, mods = {}) => fileMenuKey({ key: k, code: /^[a-z]$/i.test(k) ? "Key" + k.toUpperCase() : "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

ok(key("N", { ctrlKey: true, shiftKey: true }) === "newWindow" && key("n", { metaKey: true, shiftKey: true }) === "newWindow", "Ctrl+Shift+N (Cmd+Shift+N): New window");
ok(key("n", { ctrlKey: true, altKey: true }) === "newNotebook" && key("n", { ctrlKey: true, altKey: true, shiftKey: true }) === "newNotebook", "Ctrl+Alt+N: a new notebook, as before (with Shift too)");
ok(key("o", { ctrlKey: true }) === "open" && key("O", { ctrlKey: true, shiftKey: true }) === null, "Ctrl+O: Open…; Ctrl+Shift+O: nothing");
ok(key("n", { ctrlKey: true }) === null && key("N", { shiftKey: true }) === null && key("n") === null, "Ctrl+N, Shift+N and N alone: nothing");
ok(FILE_KEYS.newWindow === "Ctrl+Shift+N", "the menu shows Ctrl+Shift+N beside New window");

console.log(fails ? `${fails} of ${checks} failed` : `test-filemenu-keys: all ${checks} passed`);
process.exit(fails ? 1 : 0);
