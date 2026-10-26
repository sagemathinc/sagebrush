import test from "node:test";
import assert from "node:assert/strict";
import { tokensOf, submitCharge, keptCharge, Ledger, SUBMIT_PER_BYTE, SUBMIT_PER_TOKEN, KEPT_PER_BYTE, KEPT_PER_TOKEN } from "../src/board-edit-memory";

// `board open --edit`'s memory ledger (plan-board-open-edit r7 §8.2, addendum 2): the formulas as stated, the
// preflight count, and reservations converted with no interval uncharged (LIMIT-BOARD-ADD2-1).
const u8 = (s: string) => Buffer.from(s, "utf8");

test("board open --edit memory: structural tokens are counted outside strings only", () => {
  assert.equal(tokensOf(u8('{"a":1,"b":[2,3]}')), 6); // { : , : [ ,
  assert.equal(tokensOf(u8('"{[,:]}"')), 0);
  assert.equal(tokensOf(u8('{"a\\":{":[]}')), 3); // (an escaped quote doesn't end the string)
  assert.equal(tokensOf(u8('"\\\\"{}')), 1); // (an escaped backslash does end it)
  assert.equal(tokensOf(u8('{"图":"😀,"}')), 2);
  assert.equal(tokensOf(u8("")), 0);
});

test("board open --edit memory: R and Rv are the stated formulas", () => {
  const body = u8('{"type":"doc","page":"","id":""}\n{"type":"item","page":"","id":"n","parent":"","pos":0}');
  assert.equal(submitCharge(body), SUBMIT_PER_BYTE * body.length + SUBMIT_PER_TOKEN * tokensOf(body));
  assert.deepEqual([SUBMIT_PER_BYTE, SUBMIT_PER_TOKEN, KEPT_PER_BYTE, KEPT_PER_TOKEN], [18, 256, 6, 128]);
  const recs = [{ type: "doc", page: "", id: "" }, { type: "item", page: "", id: "n", parent: "", pos: 0, text: "图" }];
  const lines = recs.map((r) => JSON.stringify(r) + "\n").join("");
  assert.equal(keptCharge(recs), KEPT_PER_BYTE * Buffer.byteLength(lines) + KEPT_PER_TOKEN * tokensOf(u8(lines)));
  // (many tiny fields: the token term, not the bytes, is most of it)
  const many = u8(JSON.stringify(Object.fromEntries(Array.from({ length: 1000 }, (_, i) => ["f" + i, 0]))));
  assert.equal(tokensOf(many), 2000);
  assert.ok(SUBMIT_PER_TOKEN * 2000 > SUBMIT_PER_BYTE * many.length);
});

test("board open --edit memory: a reservation exactly filling the ledger is admitted; one byte more is not", () => {
  const l = new Ledger(1000);
  assert.ok(l.admit(400));
  const r = l.reserve(600);
  assert.ok(r);
  assert.equal(l.used, 1000);
  assert.equal(l.reserve(1), null);
  // (what is kept retained out of it: the total unchanged, never past the cap)
  r!.retain(250);
  assert.equal(l.used, 1000);
  r!.close();
  assert.equal(l.used, 650);
  r!.close(); // (twice: nothing more)
  assert.equal(l.used, 650);
  const short = new Ledger(999);
  assert.ok(short.admit(400));
  assert.equal(short.reserve(600), null);
  assert.equal(short.used, 400);
  // (admissible: at most half the cap, for good)
  assert.ok(l.admissible(500) && !l.admissible(501));
});

test("board open --edit memory: a retain past the reservation is still charged, and nothing is admitted until under", () => {
  const l = new Ledger(1000);
  const r = l.reserve(100)!;
  r.retain(150);
  assert.equal(l.used, 150);
  r.close();
  assert.equal(l.used, 150);
  assert.equal(l.reserve(851), null);
  assert.ok(l.reserve(850));
});
