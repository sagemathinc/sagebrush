import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    const union = "export type DocNode = DocNote | DocGroup | DocInk | DocSticker;";
    assert.ok(doc.includes(union));
    writeFileSync(join(dir, "web/board/doc.ts"), doc.replace(union, "/** A widget. */\nexport interface DocWidget {\n  /** required: unique on its page */\n  id: string;\n}\nexport type DocNode = DocNote | DocGroup | DocInk | DocSticker | DocWidget;"));
    const r = run(["--check"], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /DocNode's DocWidget: a kind of item with no section/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
