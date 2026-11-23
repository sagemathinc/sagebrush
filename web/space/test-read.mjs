// ci: web-browser/space order=5
// What the viewer reads, and how much (src/read.js), in Node against a server of its own: a space and a file's text
// come from this site only (another origin, a user in the URL, or a space not named .space.json is refused), a
// redirect is never followed, and an answer over the limit is refused, by its length or as it arrives. A space is
// checked whole: its depth, values, strings, objects, links and tree.
//   node web/space/test-read.mjs
import { createServer } from "node:http";

let failures = 0, checks = 0;
const ok = (c, msg, detail) => { checks++; console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 200) : "")); if (!c) failures++; };
const refuses = async (f, re) => { try { await f(); return false; } catch (e) { return re.test(String(e?.message ?? e)); } };

const server = createServer((req, res) => {
  if (req.url === "/space/a.space.json") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ format: "sagebrush-space", nodes: [] }));
  if (req.url === "/space/moved.space.json") return res.writeHead(302, { location: "/space/a.space.json" }).end();
  if (req.url === "/space/big-declared.txt") return res.writeHead(200, { "content-length": String(64) }).end("x".repeat(64));
  if (req.url === "/space/big-streamed.txt") { res.writeHead(200); for (let i = 0; i < 8; i++) res.write("y".repeat(16)); return res.end(); }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/space/`;
globalThis.location = new URL(base);
const { LIMITS, checkSpace, readText, sameSite } = await import("./src/read.js");

try {
  // ---- where from
  ok(sameSite("a.space.json", { space: true }).href === base + "a.space.json", "a space of this site, by a relative name");
  ok(await refuses(() => sameSite("https://example.com/a.space.json", { space: true }), /only files of this site/), "another origin is refused");
  ok(await refuses(() => sameSite(`http://user:pw@127.0.0.1:${server.address().port}/space/a.space.json`, { space: true }), /only files of this site/), "a URL with a user in it is refused");
  ok(await refuses(() => sameSite("/index.html", { space: true }), /a \.space\.json file/), "a space must be a .space.json file");
  ok(await refuses(() => sameSite("//example.com/x.space.json", { space: true }), /only files of this site/), "a protocol-relative URL to another host is refused");

  // ---- reading
  ok(JSON.parse(await readText(sameSite("a.space.json", { space: true }))).format === "sagebrush-space", "a space is read");
  ok(await refuses(() => readText(sameSite("moved.space.json", { space: true })), /redirect/), "a redirect is not followed");
  ok(await refuses(() => readText(sameSite("big-declared.txt"), 32), /too large/), "an answer whose length is over the limit is refused");
  ok(await refuses(() => readText(sameSite("big-streamed.txt"), 100), /too large/), "an answer that grows past the limit as it arrives is refused");
  ok((await readText(sameSite("big-streamed.txt"), 128)).length === 128, "and one within it is read whole");

  // ---- a space, checked whole
  const sp = (x) => ({ format: "sagebrush-space", nodes: [], ...x });
  ok(checkSpace(sp({})).format === "sagebrush-space", "a small space passes");
  ok(await refuses(() => checkSpace({ nodes: [] }), /isn't a sagebrush-space/), "something else is refused");
  let deep = {}; for (let i = 0; i < LIMITS.depth + 2; i++) deep = { x: deep };
  ok(await refuses(() => checkSpace(sp({ extra: deep })), /nested too deeply/), "a space nested too deeply is refused");
  ok(await refuses(() => checkSpace(sp({ extra: "z".repeat(LIMITS.string + 1) })), /too long/), "a text over the limit is refused");
  ok(await refuses(() => checkSpace(sp({ nodes: Array.from({ length: LIMITS.nodes + 1 }, (_, i) => ({ id: String(i) })) })), /objects/), "too many objects are refused");
  ok(await refuses(() => checkSpace(sp({ edges: Array.from({ length: LIMITS.edges + 1 }, () => ({})) })), /links/), "too many links are refused");
  ok(await refuses(() => checkSpace(sp({ extra: new Array(LIMITS.values + 1).fill(0) })), /too large/), "too many values in all are refused");
  ok(await refuses(() => checkSpace(sp({ tree: { files: "not a list" } })), /tree/), "a tree whose files aren't a list is refused");
  ok(await refuses(() => checkSpace(sp({ nodes: "x" })), /objects aren't a list/), "objects that aren't a list are refused");
} finally {
  server.close();
}
console.log(failures ? `${failures} of ${checks} FAILED` : `all ${checks} passed`);
process.exit(failures ? 1 : 0);
