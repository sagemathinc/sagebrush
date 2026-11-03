// ci: web-runner order=120
// `sagebrush notebook DIR` (src/notebook.ts) reads, writes and lists only what is really inside DIR: a symbolic link in
// DIR to elsewhere (a folder, a file, or one that points nowhere) is no way out, for api/file's GET and PUT, the
// listing and the notebook page alike (astra's LOCAL-RENAME-1, found on #531's rename, for every route: @sagebrush).
// A link inside DIR to something inside DIR still works.
//   node web/test-local-contain.mjs [bundle]     (default build/cli/pyjs.cjs)
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, symlinkSync, readdirSync, unlinkSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./test-port.mjs";

const bundle = process.argv[2] ?? new URL("../build/cli/pyjs.cjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0, count = 0;
const ok = (cond, name) => { count++; console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };

const dir = mkdtempSync(join(tmpdir(), "sb-local-contain-"));
const outside = mkdtempSync(join(tmpdir(), "sb-local-contain-outside-"));
const SECRET = '{"cells": [], "metadata": {}, "nbformat": 4, "nbformat_minor": 5, "secret": "outside"}';
writeFileSync(join(outside, "secret.ipynb"), SECRET);
mkdirSync(join(dir, "sub"));
writeFileSync(join(dir, "sub", "mine.ipynb"), '{"cells": [], "metadata": {}, "nbformat": 4, "nbformat_minor": 5}');
symlinkSync(outside, join(dir, "jump"));                         // a folder out of DIR
symlinkSync(join(outside, "secret.ipynb"), join(dir, "link.ipynb")); // a file out of DIR
symlinkSync(join(outside, "nothing-yet.ipynb"), join(dir, "dangling.ipynb")); // a link to a name out of DIR, not there yet
symlinkSync(join(dir, "sub"), join(dir, "alias"));                // a link inside DIR to inside DIR: fine
const port = await freePort();
const server = spawn(process.execPath, [bundle, "notebook", dir, "--port", String(port), "--no-browser"], { stdio: ["ignore", "pipe", "inherit"] });
let printed = "";
server.stdout.on("data", (d) => (printed += d));
for (let i = 0; i < 100 && !/token=/.test(printed); i++) await sleep(100);
const token = /token=(\w+)/.exec(printed)?.[1];
ok(!!token, "the server prints its URL with a token");
const base = `http://127.0.0.1:${port}`, headers = { Cookie: `sagebrush_token=${token}` };
const get = (p) => fetch(`${base}/api/file?path=${encodeURIComponent(p)}`, { headers }).then(async (r) => ({ status: r.status, text: await r.text() }));
const put = (p, text) => fetch(`${base}/api/file?path=${encodeURIComponent(p)}`, { method: "PUT", headers, body: text }).then((r) => r.status);
const page = (p) => fetch(`${base}${p}`, { headers, redirect: "manual" }).then(async (r) => ({ status: r.status, text: await r.text() }));
const outsideNames = () => readdirSync(outside).sort().join(",");

try {
  // reads
  let r = await get("jump/secret.ipynb");
  ok(r.status === 400 && !r.text.includes("outside"), `GET through a folder linked out of DIR: refused (${r.status})`);
  r = await get("link.ipynb");
  ok(r.status === 400 && !r.text.includes("outside"), `GET of a file linked out of DIR: refused (${r.status})`);
  r = await get("dangling.ipynb");
  ok(r.status === 400, `GET of a link to a name out of DIR: refused (${r.status})`);
  // writes
  ok((await put("jump/new.ipynb", "{}")) === 400 && outsideNames() === "secret.ipynb", "PUT through a folder linked out of DIR: refused, nothing made outside");
  ok((await put("jump/deep/er/new.ipynb", "{}")) === 400 && outsideNames() === "secret.ipynb", "PUT into folders to be made under that link: refused, no folder made outside");
  ok((await put("link.ipynb", "{\"pwned\": true}")) === 400 && readFileSync(join(outside, "secret.ipynb"), "utf8") === SECRET, "PUT to a file linked out of DIR: refused, the file outside untouched");
  ok((await put("dangling.ipynb", "{}")) === 400 && !existsSync(join(outside, "nothing-yet.ipynb")), "PUT through a dangling link out of DIR: refused, no file made outside");
  // the listing and the notebook page
  r = await page("/tree/jump");
  ok(r.status === 404 && !r.text.includes("secret"), `the listing of a folder linked out of DIR: refused (${r.status})`);
  r = await page("/nb/jump/secret.ipynb/");
  ok(r.status === 400, `the notebook page of a file linked out of DIR: refused (${r.status})`);
  // (astra's LOCAL-CONTAIN-1) a link already at the old temporary name (x.ipynb.sagebrush-tmp) to a file outside: the
  // write uses a fresh name, made exclusively, and never goes through it
  symlinkSync(join(outside, "secret.ipynb"), join(dir, "sub", "x.ipynb.sagebrush-tmp"));
  ok((await put("sub/x.ipynb", '{"cells": ["mine"]}')) === 200 && readFileSync(join(dir, "sub", "x.ipynb"), "utf8").includes("mine") && readFileSync(join(outside, "secret.ipynb"), "utf8") === SECRET, "a link at the old temporary name to a file outside: the PUT writes in DIR only, the file outside untouched");
  ok(!readdirSync(join(dir, "sub")).some((f) => /\.sagebrush-tmp-/.test(f)), "…and leaves no temporary file");
  // (astra's LOCAL-CONTAIN-2) a link in the path switched to elsewhere while the body is still coming: checked again
  // when it has come, so refused, nothing made outside
  mkdirSync(join(dir, "sub2"));
  symlinkSync(join(dir, "sub2"), join(dir, "alias2"));
  const held = await new Promise((resolve) => {
    const r = request({ host: "127.0.0.1", port, method: "PUT", path: `/api/file?path=${encodeURIComponent("alias2/new.ipynb")}`, headers: { ...headers, Host: `127.0.0.1:${port}`, "Transfer-Encoding": "chunked" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    r.on("error", () => resolve(0));
    r.write('{"cells": [');
    setTimeout(() => { unlinkSync(join(dir, "alias2")); symlinkSync(outside, join(dir, "alias2")); r.end('"late"]}'); }, 500);
  });
  ok(held === 400 && !existsSync(join(outside, "new.ipynb")) && !existsSync(join(dir, "sub2", "new.ipynb")), `a link switched outside while the body came: refused (${held}), nothing made outside or in`);
  ok(outsideNames() === "secret.ipynb", `…and outside holds only what it held (${outsideNames()})`);

  // what is inside DIR still works, a link within DIR too
  r = await get("sub/mine.ipynb");
  ok(r.status === 200 && r.text.includes("nbformat"), "GET of a notebook in DIR: 200");
  ok((await put("sub/new.ipynb", '{"cells": []}')) === 200 && existsSync(join(dir, "sub", "new.ipynb")), "PUT of a new notebook in a folder of DIR: 200");
  ok((await put("brand/new/folder/x.ipynb", '{"cells": []}')) === 200 && existsSync(join(dir, "brand", "new", "folder", "x.ipynb")), "PUT into new folders in DIR: 200");
  r = await get("alias/mine.ipynb");
  ok(r.status === 200 && r.text.includes("nbformat"), "GET through a link in DIR to a folder in DIR: 200");
  ok((await page("/tree/sub")).status === 200, "the listing of a folder in DIR: 200");
} catch (e) {
  ok(false, "threw: " + String(e?.stack ?? e).slice(0, 600));
} finally {
  server.kill();
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
console.log(failures ? `${failures} of ${count} failed` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
