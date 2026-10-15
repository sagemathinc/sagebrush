import test from "node:test";
import assert from "node:assert/strict";
import { layout } from "../web/board/doc";

// The board's layouts (web/board/doc.ts arrange).
const box = (id: string, h: number) => ({ id, text: id, w: 200, h });
const at = (items: any[], id: string) => items.find((it) => it.id === id)!;

test("a grid: each row as tall as its own tallest box, not the board's tallest", () => {
  // (three columns: a short row, a row with a tall box, a short row)
  const nodes = [box("a", 100), box("b", 100), box("c", 100), box("d", 400), box("e", 80), box("f", 80), box("g", 60), box("h", 60)];
  for (const doc of [{ layout: "grid", columns: 3, nodes }, { nodes: [{ id: "grp", kind: "group", layout: "grid", columns: 3, children: nodes }] }]) {
    const { items } = layout(doc as any);
    const y = (id: string) => at(items, id).y, x = (id: string) => at(items, id).x;
    // (rows: one top for each, the gap between them 40)
    assert.equal(y("b"), y("a"));
    assert.equal(y("e"), y("d"));
    assert.equal(y("d") - y("a"), 100 + 40, "the first row is as tall as its boxes");
    assert.equal(y("g") - y("d"), 400 + 40, "the second as tall as its tall box");
    // (columns: as wide as the widest box)
    assert.equal(x("b") - x("a"), 200 + 40);
    assert.equal(x("g"), x("a"));
  }
});
