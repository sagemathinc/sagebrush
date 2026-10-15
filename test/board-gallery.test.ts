import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

// The gallery of example boards (web/board/examples/gallery-*.board.json,
// one per area, linked from llms.txt): each one's every code item runs
// (`sagebrush board run`), and it draws (`sagebrush board render`).
const examples = __dirname + "/../../web/board/examples/";
const gallery = readdirSync(examples).filter((f) => /^gallery-.*\.board\.json$/.test(f)).sort();
const cli = (args: string[]) => spawnSync(process.execPath, [__dirname + "/../src/cli.js", "board", ...args], { encoding: "utf8", timeout: 300_000 });

test("the gallery: a board for each area, and one with every kind of item", () => {
  assert.deepEqual(gallery, ["calculus", "hello", "linear-algebra", "magma", "matlab", "number-theory", "plots"].map((n) => `gallery-${n}.board.json`));
});

// (a board's code items as its file has them, found here and not by board
// run: page by page, in groups too, each as [page, id], its page from 1)
function codeItems(d: any): string[] {
  const out: string[] = [];
  const walk = (ns: any[] | undefined, page: number) => {
    for (const n of ns ?? []) {
      if (n.kind === "group") walk(n.children, page);
      else if (n.kind !== "ink" && n.kind !== "sticker" && typeof n.code === "string") out.push(JSON.stringify([page, n.id]));
    }
  };
  (d.pages ?? [d]).forEach((p: any, i: number) => walk(p.nodes, i + 1));
  return out.sort();
}
// (the report has every one of them, each once, and each ran ok, TEST-285-4)
function allRan(d: any, report: any) {
  const ran = report.items.map((i: any) => JSON.stringify([i.page ?? 1, i.id])).sort();
  assert.deepEqual(ran, codeItems(d), "the report's items are the board's code items");
  for (const i of report.items) assert.equal(i.status, "ok", JSON.stringify(i));
}

for (const f of gallery) {
  test(`gallery ${f}: every code item runs, and it draws`, () => {
    const d = JSON.parse(readFileSync(examples + f, "utf8"));
    assert.equal(d.format, "sagebrush-board");
    assert.equal(d.version, 1);
    const r = cli(["run", examples + f, "--json"]);
    const report = JSON.parse(r.stdout);
    assert.equal(r.status, 0, JSON.stringify(report.items.filter((i: any) => i.status !== "ok")));
    assert.ok(report.ok && report.items.length > 0);
    allRan(d, report);
    // (and a report missing one, or with one not run, is caught)
    assert.throws(() => allRan(d, { ...report, items: report.items.slice(1) }));
    assert.throws(() => allRan(d, { ...report, items: report.items.map((i: any, k: number) => (k ? i : { ...i, status: "not run" })) }));
    const s = cli(["render", examples + f]);
    assert.equal(s.status, 0, s.stderr);
    assert.match(s.stdout, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[\s\S]*<\/svg>\n$/);
  });
}
