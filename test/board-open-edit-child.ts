// `sagebrush board open FILE --edit` in a process of its own, for test/board-edit-r3.test.ts: the production
// server (src/board-open.ts) with a minimal page and _headers given as the bundle's embedded assets would be,
// so that its routing is what is tested.  argv: FILE PORT [--limit NAME=VALUE]...; prints what boardOpen prints
// (the URL with its token); SIGINT stops it.
import { gzipSync } from "zlib";
import { boardOpen } from "../src/board-open";

const page = '<html><head><title>board</title></head><body><script type="application/json" id="sb-doc" data-sb-from="parent">null</script></body></html>';
const headers = "/frame/*\n  Content-Security-Policy: default-src 'self'; sandbox allow-scripts; frame-ancestors *\n";
(globalThis as any).__SAGEBRUSH_WEB__ = {
  "frame/board/index.html.gz": gzipSync(Buffer.from(page)).toString("base64"),
  _headers: Buffer.from(headers).toString("base64"),
};
const [file, port, ...rest] = process.argv.slice(2);
boardOpen([file, "--edit", "--no-browser", "--port", port, ...rest]).then((code) => process.exit(code));
