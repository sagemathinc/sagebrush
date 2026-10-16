import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanDoc, layout } from "../web/board/doc";

// The board format's field reference (web/board-format.md's Fields) is
// written from web/board/doc.ts's doc comments by
// scripts/board-format-fields.mjs: it is as they say, and a field without
// one, or a required field not saying so, is refused.
const repo = join(__dirname, "..", "..");
const script = join(repo, "scripts", "board-format-fields.mjs");
const run = (args: string[], root?: string) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, ...(root ? { BOARD_FORMAT_ROOT: root } : {}) } });

test("web/board-format.md's Fields are as web/board/doc.ts says", () => {
  const r = run(["--check"]);
  assert.equal(r.status, 0, r.stderr);
});

test("the field reference: every field of every item, its type written out", () => {
  const r = run(["--stdout"]);
  assert.equal(r.status, 0, r.stderr);
  for (const h of ["### The document", "### A page (in `pages`)", "### A note (the default item)", "### A group", "### An edge", "### A tour step", "### A sticker", "### Ink", "### A picture (in `images`)"]) assert.ok(r.stdout.includes(h + "\n"), h);
  assert.match(r.stdout, /\| `mode` \| `"python"` \\\| `"sage"` \\\| `"magma"` \\\| `"matlab"` \|/);
  assert.match(r.stdout, /\| `nodes` \| \[item\] \| required: the page's items \|/);
  assert.match(r.stdout, /\| `images` \| \{name: picture\} \|/);
});

test("a field without a doc comment, or required without saying so, is refused; a page not as written is found", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-fields-"));
  try {
    mkdirSync(join(dir, "web", "board"), { recursive: true });
    for (const f of ["web/board/doc.ts", "web/board/images.ts", "web/board-format.md"]) cpSync(join(repo, f), join(dir, f));
    const doc = readFileSync(join(dir, "web/board/doc.ts"), "utf8");
    writeFileSync(join(dir, "web/board/doc.ts"), doc.replace("  /** a label on it (plain text) */\n  label?: string;", "  label?: string;"));
    let r = run(["--check"], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /DocEdge\.label: no doc comment/);
    writeFileSync(join(dir, "web/board/doc.ts"), doc.replace("/** required: an item's id */\n  from: string;", "/** an item's id */\n  from: string;"));
    r = run(["--check"], dir);
    assert.match(r.stderr, /DocEdge\.from: required, but its comment doesn't start "required"/);
    writeFileSync(join(dir, "web/board/doc.ts"), doc.replace("/** a label on it (plain text) */", "/** a label on it, in plain text */"));
    r = run(["--check"], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not as web\/board\/doc\.ts says/);
    assert.equal(run([], dir).status, 0);
    assert.match(readFileSync(join(dir, "web/board-format.md"), "utf8"), /\| `label` \| string \| a label on it, in plain text \|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a kind of item added to DocNode without a section is refused (HARD-EC7-1)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-fields-"));
  try {
    mkdirSync(join(dir, "web", "board"), { recursive: true });
    for (const f of ["web/board/doc.ts", "web/board/images.ts", "web/board-format.md"]) cpSync(join(repo, f), join(dir, f));
    const doc = readFileSync(join(dir, "web/board/doc.ts"), "utf8");
    const union = "export type DocNode = DocNote | DocGroup | DocInk | DocSticker | DocAsk;";
    assert.ok(doc.includes(union));
    writeFileSync(join(dir, "web/board/doc.ts"), doc.replace(union, "/** A widget. */\nexport interface DocWidget {\n  /** required: unique on its page */\n  id: string;\n}\nexport type DocNode = DocNote | DocGroup | DocInk | DocSticker | DocAsk | DocWidget;"));
    const r = run(["--check"], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /DocNode's DocWidget: a kind of item with no section/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a note's width as the reference says it: 260, 440 for code, a picture-only note its picture's width up to 480 (DOC-EC7-2)", () => {
  const r = run(["--stdout"]);
  assert.match(r.stdout, /\| `w` \| number \| its width \(default 260; 440 for a code item; for a note with only a picture, the picture's width, up to 480, its height then from the picture's shape\) \|/);
  const src = "data:image/png;base64,iVBORw0KGgo=";
  const { items } = layout({ nodes: [{ id: "big", image: "big" }, { id: "small", image: "small" }, { id: "text", text: "hi" }, { id: "code", code: "1" }], images: { big: { w: 800, h: 600, src }, small: { w: 200, h: 100, src } } } as any);
  const size = (id: string) => { const it = items.find((x: any) => x.id === id)!; return [it.w, it.h]; };
  assert.deepEqual(size("big"), [480, 360]);
  assert.deepEqual(size("small"), [200, 100]);
  assert.equal(size("text")[0], 260);
  assert.equal(size("code")[0], 440);
});

test("a picture's name as the reference says it, letters, digits, _ and -, at most 100 characters, and what cleanDoc keeps (DOC-EC7-3)", () => {
  const r = run(["--stdout"]);
  assert.match(r.stdout, /\| `images` \| \{name: picture\} \| pictures by name: .*A name is letters, digits, `_` and `-`, at most 100 characters \(`plot-1`, not `plot 1` or `figure\.png`\)/);
  assert.match(r.stdout, /\| `image` \| string \| a picture: its name in the document's `images` \(letters, digits, `_` and `-`, at most 100 characters\) \|/);
  assert.match(r.stdout, /\| `src` \| string \| its bytes, which a file needs to show the picture:/);
  const src = "data:image/png;base64,iVBORw0KGgo=", pic = { w: 10, h: 10, src };
  const names = ["plot-1", "plot_2", "x".repeat(100), "plot 1", "figure.png", "x".repeat(101)];
  const d = cleanDoc({ nodes: names.map((n, i) => ({ id: "n" + i, image: n })), images: Object.fromEntries(names.map((n) => [n, pic])) } as any);
  assert.deepEqual(Object.keys(d.images ?? {}), names.slice(0, 3));
  assert.deepEqual((d.nodes ?? []).map((n: any) => n.image ?? null), [...names.slice(0, 3), null, null, null]);
});

test("every type the reference writes in words is a section's, item, or object (DOC-EC7-4)", () => {
  const r = run(["--stdout"]);
  assert.match(r.stdout, /`item` is any of note, group, ink, sticker or question;/);
  assert.match(r.stdout, /\| `preview` \| object \| a slow code item's output, kept to show before it runs \(written by Sagebrush\) \|/);
  const sections = new Set(["note", "group", "edge", "step", "page", "card", "background", "picture", "sticker", "ink", "question", "option"]);
  for (const row of r.stdout.split("\n").filter((l) => /^\| `\w+` \|/.test(l))) {
    const type = row.split(/(?<!\\)\|/)[2].replace(/`[^`]*`/g, "");
    for (const w of type.match(/[a-z]+/g) ?? []) assert.ok(["string", "number", "boolean", "object", "item", "name"].includes(w) || sections.has(w), `${w} in ${row}`);
  }
});
