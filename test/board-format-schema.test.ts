import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanDoc, safeColor } from "../web/board/doc";
import { SchemaValidator, didYouMean } from "../src/json-schema";

// The board format's JSON Schema (web/board-format.schema.json), written
// from web/board/doc.ts by scripts/board-format-schema.mjs, against the
// board's own loader (doc.ts cleanDoc): what the schema takes the loader
// keeps as it is, and a value the loader drops the schema refuses, field by
// field; the few places the schema is deliberately stricter or looser are
// listed below with the reason.
const repo = join(__dirname, "..", "..");
const script = join(repo, "scripts", "board-format-schema.mjs");
const run = (args: string[], root?: string) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, ...(root ? { BOARD_FORMAT_ROOT: root } : {}) } });
const schema = JSON.parse(readFileSync(join(repo, "web", "board-format.schema.json"), "utf8"));
const v = new SchemaValidator(schema);

test("web/board-format.schema.json is as web/board/doc.ts says", () => {
  const r = run(["--check"]);
  assert.equal(r.status, 0, r.stderr);
});

test("every example board is valid", () => {
  const dir = join(repo, "web", "board", "examples");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");
  assert.ok(files.length >= 10);
  for (const f of files) assert.deepEqual(v.validate(JSON.parse(readFileSync(join(dir, f), "utf8"))), [], f);
});

// A board with every field of every kind of thing, each a value the format takes.
const PREVIEW = { at: "2026-10-15T00:00:00.000Z", ms: 1200, total: 1500, outputs: [{ output_type: "stream", name: "stdout", text: "2\n" }] };
function full(): any {
  return {
    format: "sagebrush-board", version: 1, title: "All of it", mode: "magma", engine: "latest", seed: "ab".repeat(32), refBase: "https://example.org/blob/main/",
    tools: ["select", "note"], intro: "Hello", images: { "pic-1": { w: 40, h: 30, src: "https://example.org/a.png" }, pic_2: { w: 1, h: 1, src: "data:image/png;base64,iVBORw0KGgo=" }, pic3: { w: 5, h: 5 } },
    pages: [
      { id: "t", title: "Template", intro: "x", layout: "row", columns: 2, direction: "LR", slide: { x: 0, y: 0, w: 1600, h: 900 }, background: { color: "#fff", image: "pic-1" }, template: true, nodes: [] },
      {
        id: "p", title: "Page", intro: "Its intro", layout: "grid", columns: 3, direction: "TB", uses: "t", background: { color: "rgb(1, 2, 3)" },
        nodes: [
          { id: "n1", kind: "note", title: "T", image: "pic-1", text: "$x$", code: "1 + 1;", hideCode: true, preview: PREVIEW, detail: "d", ref: "src/a.ts#L1", color: "#e8f0fb", shape: "round", fit: true, x: 1, y: 2, w: 300, h: 100 },
          { id: "g1", kind: "group", title: "G", text: "t", layout: "graph", columns: 2, direction: "LR", color: "hsl(10, 20%, 30%)", x: 0, y: 0, children: [{ id: "n2", text: "inside" }] },
          { id: "i1", kind: "ink", points: [3, 3, 0.5, 13, 13, 0.5], size: 3, color: "blue", opacity: 0.5, x: 7, y: 8 },
          { id: "s1", kind: "sticker", emoji: "🌵", color: "green", x: 0, y: 0, w: 64 },
          { id: "s2", kind: "sticker", icon: "star", color: "red" },
          { id: "q1", kind: "ask", title: "Q", text: "Which?", input: "radio", options: ["a", { value: "b", label: "B" }], required: true, min: 1, max: 5, step: 1, low: "l", high: "h", lines: 2, answer: "a", detail: "d", color: "#fff", x: 0, y: 0, w: 320, h: 100 },
        ],
        edges: [{ from: "n1", to: "g1", label: "l", hidden: true, arrow: "both", line: "dotted" }, { from: "n2", to: "s1", arrow: "none", line: "thick" }],
        steps: [{ focus: ["n1", "g1"], say: "Look" }, { focus: "s1" }],
      },
    ],
  };
}
// (as the loader writes a document: format and version first)
const loaded = (d: any) => JSON.parse(JSON.stringify(cleanDoc(JSON.parse(JSON.stringify(d)))));
// (a document as the loader writes it back: a note's kind "note" is the same as none)
function same(d: any): any {
  const c = JSON.parse(JSON.stringify(d));
  const walk = (ns: any[] | undefined) => { for (const n of ns ?? []) { if (n.kind === "note") delete n.kind; if (n.children) walk(n.children); } };
  walk(c.nodes);
  for (const p of c.pages ?? []) walk(p.nodes);
  return c;
}

test("a board with every field the schema takes: the loader keeps all of it as it is", () => {
  assert.deepEqual(v.validate(full()), []);
  assert.deepEqual(loaded(full()), same(full()));
  // (a one-page board too)
  const one = { ...full(), ...full().pages[1] };
  delete one.pages; delete one.id; delete one.uses;
  assert.deepEqual(v.validate(one), []);
  assert.deepEqual(loaded(one), same(one));
});

// a path into a document: ["pages", 1, "nodes", 0, "color"]
type Path = (string | number)[];
const get = (o: any, p: Path) => p.reduce((a, k) => (a == null ? undefined : a[k]), o);
function set(o: any, p: Path, value: unknown) {
  const parent = get(o, p.slice(0, -1));
  if (value === undefined) delete parent[p.at(-1)!];
  else parent[p.at(-1)!] = value;
}
const P = ["pages", 1], N = (i: number) => [...P, "nodes", i];
// [path, values the loader drops (or changes)]
const BAD: [Path, unknown[]][] = [
  [["format"], ["sagebrush", 1]], [["title"], [3]], [["mode"], ["sage-math", "octave"]], [["engine"], ["newest", true]], [["seed"], ["AB".repeat(32), "ab", 5]],
  [["refBase"], [1]], [["tools"], ["select"]], [["intro"], [{}]], [["images"], [[], "x"]],
  [["images", "pic-1", "w"], [0, -1, "40"]], [["images", "pic-1", "h"], [0]], [["images", "pic-1", "src"], ["http://example.org/a.png", "data:image/svg+xml;base64,AAAA", "javascript:x"]],
  [[...P, "layout"], ["tree"]], [[...P, "direction"], ["RL"]], [["pages", 0, "slide", "w"], [0, -5]], [[...P, "background", "color"], ["url(x)", "red;"]],
  [[...P, "background", "image"], ["a b", "x.png"]], [[...P, "template"], ["yes"]], [[...P, "title"], [[]]],
  [[...N(0), "image"], ["figure 1.png", "a/b"]], [[...N(0), "color"], ["red; x: y", "#12", "javascript:1"]], [[...N(0), "shape"], ["square"]],
  [[...N(0), "fit"], ["yes"]], [[...N(0), "x"], ["1"]], [[...N(0), "kind"], ["image", "picture"]], [[...N(0), "colour"], ["red"]],
  [[...N(1), "layout"], ["tree"]], [[...N(1), "direction"], ["BT"]], [[...N(1), "color"], ["nope!"]],
  [[...N(2), "size"], [0, 500]], [[...N(2), "opacity"], [1, 0, 2]], [[...N(2), "points"], [[], ["a", 1, 2], [3, 3, 0.5, 13], [3, 3, 4, 13, 13, 0.5]]], [[...N(2), "x"], [undefined]],
  [[...N(3), "emoji"], ["ab", "", "🌵🌵", 5]], [[...N(3), "w"], [4, 5000]], [[...N(4), "icon"], ["Star", "a b"]],
  [[...N(5), "input"], ["slider", 1]], [[...N(5), "options"], ["a", [5], [{ value: 5 }], [{ value: "b", label: 3 }], [["a"]]]], [[...N(5), "answer"], [{}, [1], null, ["a", 2]]],
  [[...N(5), "required"], ["yes"]], [[...N(5), "lines"], ["2"]], [[...N(5), "color"], ["nope!"]], [[...N(5), "min"], ["1"]], [[...N(5), "question"], ["Which?"]],
  [[...P, "edges", 0, "arrow"], ["end"]], [[...P, "edges", 0, "line"], ["dashed"]], [[...P, "edges", 0, "hidden"], ["true"]], [[...P, "edges", 0, "weight"], [2]],
  [[...P, "steps", 1, "focus"], [3, undefined]], [[...P, "steps", 0, "camera"], [1]],
];
// Where the schema refuses what the loader still takes (coerced or
// accepted for old documents), and why it does.
const STRICTER: Record<string, string> = {
  '["format"]=1': "the format is a string; the loader takes a document whose format isn't \"sagebrush-board\" only to say it isn't a board (formatError)",
  '["format"]="sagebrush"': "as above: formatError says it isn't a Sagebrush board",
  '["pages",1,"title"]=[]': "text is a string: the loader turns any value into a string, which a writer shouldn't rely on",
  '["title"]=3': "as above", '["refBase"]=1': "as above", '["intro"]={}': "as above",
  '["images","pic-1","w"]="40"': "pixels are a number: the loader drops the picture, so the schema refuses it",
  '["pages",1,"nodes",0,"x"]="1"': "a position is a number (the loader leaves out a string one)",
  '["pages",1,"nodes",1,"columns"]=2.5': "a grid's columns are a whole number (the layout takes any number, with odd results)",
};
const LOOSER: Record<string, string> = {
  '["pages",1,"nodes",3,"emoji"]="🌵🌵"': "one emoji (one grapheme) isn't a pattern: `sagebrush board check` checks it as the board does (doc.ts oneEmoji)",
  // (ink is drawn by a person, never written: the format says "Don't write these")
  '["pages",1,"nodes",2,"points"]=[3,3,0.5,13]': "an ink stroke's trailing incomplete point is dropped by the loader; a schema can't say an array's length is a multiple of 3",
  '["pages",1,"nodes",2,"points"]=[3,3,4,13,13,0.5]': "an ink point's pressure is clamped to [0, 1] by the loader; the schema doesn't constrain each third number",
};
// (also not field fidelity, by design: a preview is written by Sagebrush and
// the schema takes any object for it, the loader keeping only a valid one;
// a note's legacy `kind: "code"` is read by the loader as a code note, and
// refused by the schema, which describes what to write)

test("field by field: the schema refuses a value exactly when the loader leaves it out", () => {
  const base = full(), kept = loaded(base), out: string[] = [];
  for (const [path, values] of BAD) {
    for (const value of values) {
      const d = full();
      set(d, path, value);
      const refused = v.validate(d).length > 0;
      const after = loaded(d), node = path.slice(0, 5);
      // (kept: the same value at the same place; a dropped item moves the next one up)
      const loaderKeeps = value !== undefined && JSON.stringify(get(after, path)) === JSON.stringify(value) && (path[2] !== "nodes" || get(after, [...node.slice(0, 4), "id"]) === get(kept, [...node.slice(0, 4), "id"]));
      const key = `${JSON.stringify(path)}=${JSON.stringify(value)}`;
      if (refused && !loaderKeeps) continue;
      if (refused && loaderKeeps && key in STRICTER) continue;
      if (!refused && !loaderKeeps && key in LOOSER) continue;
      if (!refused && !loaderKeeps && value === undefined && JSON.stringify(after) === JSON.stringify(kept)) continue;
      out.push(`${key}: schema ${refused ? "refuses" : "takes"} it, loader ${loaderKeeps ? "keeps" : "drops"} it`);
    }
  }
  assert.deepEqual(out, []);
  // (and every listed exception still is one)
  for (const key of [...Object.keys(STRICTER), ...Object.keys(LOOSER)]) assert.ok(BAD.some(([p, vs]) => vs.some((x) => `${JSON.stringify(p)}=${JSON.stringify(x)}` === key)) || key === '["pages",1,"nodes",1,"columns"]=2.5', key);
});

test("names from JavaScript's prototypes are a document's names like any other (CORR-7A7-1)", () => {
  // (as JSON text: an object literal with __proto__ would set a prototype)
  const parse = (t: string) => JSON.parse(t);
  const doc = (node: string, images = "") => parse(`{"format": "sagebrush-board", "version": 1, ${images}"nodes": [${node}]}`);
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const d = doc(`{"id": "a", "${name}": 123}`);
    assert.deepEqual(v.validate(d).map((p) => p.path + ": " + p.message.split(" (")[0].split(";")[0]), [`nodes[0].${name}: unknown field \`${name}\``], name);
  }
  // (a picture named constructor: checked as a picture, valid or not)
  assert.deepEqual(v.validate(doc(`{"id": "a", "image": "constructor"}`, `"images": {"constructor": {"w": 10, "h": 10, "src": "https://example.org/a.png"}}, `)), []);
  const bad = doc(`{"id": "a", "image": "constructor"}`, `"images": {"constructor": {"w": -1, "h": 0, "src": "file:///a"}}, `);
  assert.deepEqual(v.validate(bad).map((p) => p.path), ["images.constructor.w", "images.constructor.h", "images.constructor.src"]);
  assert.equal(loaded(bad).images, undefined);
  // (required fields too: an item without its own id)
  assert.deepEqual(v.validate(doc(`{"text": "no id"}`)).map((p) => p.message), ["needs `id`: unique on its page (an edge names it)"]);
});

test("numbers past a double's range (1e999 in JSON text) are refused, as the loader drops them (CORR-7A7-2)", () => {
  const note = JSON.parse('{"format": "sagebrush-board", "version": 1, "nodes": [{"id": "a", "text": "Hello", "w": 1e999}]}');
  assert.equal(note.nodes[0].w, Infinity);
  assert.deepEqual(v.validate(note).map((p) => `${p.path}: ${p.message}`), ["nodes[0].w: should be a finite number: Infinity (a number past about 1.8e308, such as 1e999, is read as infinity)"]);
  assert.equal(loaded(note).nodes[0].w, undefined);
  const slide = JSON.parse('{"format": "sagebrush-board", "version": 1, "slide": {"x": 0, "y": 0, "w": 1e999, "h": 20}, "nodes": []}');
  assert.deepEqual(v.validate(slide).map((p) => p.path), ["slide.w"]);
  assert.equal(loaded(slide).slide, undefined);
  assert.deepEqual(v.validate(JSON.parse('{"format": "sagebrush-board", "version": 1, "nodes": [{"id": "a", "x": -1e999}]}')).map((p) => p.path), ["nodes[0].x"]);
  // (the largest double is kept, and valid; the published schema bounds every number so that other validators refuse infinity too)
  const big = JSON.parse('{"format": "sagebrush-board", "version": 1, "nodes": [{"id": "a", "w": 1.7976931348623157e308}]}');
  assert.deepEqual(v.validate(big), []);
  assert.equal(loaded(big).nodes[0].w, Number.MAX_VALUE);
  assert.deepEqual(schema.$defs.DocNote.properties.w.maximum, Number.MAX_VALUE);
});

test("a grid's columns: a whole number, though the loader keeps any (listed)", () => {
  const d = full();
  d.pages[1].nodes[1].columns = 2.5;
  assert.equal(v.validate(d)[0]?.message, "should be a whole number, not a number (2.5)");
  assert.equal(loaded(d).pages[1].nodes[1].columns, 2.5);
});

test("colors: the schema's pattern takes what the board's safeColor takes", () => {
  const colorSchema = schema.$defs.DocNote.properties.color;
  const samples = ["red", "RED", " red ", "#fff", "#FFF", "#e8f0fb", "#12345678", "#123456789", "#12", "rgb(1, 2, 3)", "RGBA(1,2,3,0.5)", "hsl(10deg, 20%, 30%)", "hsla(1, 2%, 3%, 0.4)",
    "rgb(1,2)", "url(x)", "red;", "javascript:1", "", "aa", "averyveryverylongcolorname", "rgb( 1 , 2 , 3 )", "#ggg", "transparent", "rgb(1,2,3", "hsl(1, 2, 3, 4, 5)"];
  for (const c of samples) assert.equal(v.valid(colorSchema, c), safeColor(c) !== undefined, JSON.stringify(c));
});

test("the validator's messages say where, what, and for a misspelt field what was meant", () => {
  const d = full();
  d.pages[1].nodes[0].colour = "red";
  d.pages[1].nodes.push({ id: "z", kind: "image" }, { id: "y", kind: "sticker" });
  d.pages[1].edges.push({ from: "n1", too: "s1" });
  const got = v.validate(d).map((p) => `${p.path}: ${p.message}`);
  assert.deepEqual(got, [
    "pages[1].nodes[0].colour: unknown field `colour` (did you mean `color`?)",
    "pages[1].nodes[6].kind: unknown kind \"image\": one of \"note\", \"group\", \"ink\", \"sticker\", \"ask\" (a note's kind may be left out)",
    "pages[1].nodes[7]: needs `emoji` or `icon`",
    "pages[1].edges[2]: needs `to`: an item's id",
    "pages[1].edges[2].too: unknown field `too` (did you mean `to`?)",
  ]);
  assert.equal(didYouMean("Columns", ["columns", "color"]), "columns");
  // (a transposition is one edit)
  assert.equal(didYouMean("titel", ["title", "text"]), "title");
  // (a document's field on an item: where it belongs)
  const m = full();
  m.pages[1].nodes[0].seed = "ab".repeat(32);
  assert.equal(v.validate(m)[0].message, "unknown field `seed` (`seed` is the board's, written at the top)");
  // (`mode`: a code item may have its own (item 16); on a group it is unknown, and says where it belongs)
  const own = full();
  own.pages[1].nodes[0].mode = "sage";
  assert.deepEqual(v.validate(own), []);
  const grp = full();
  grp.pages[1].nodes[1].mode = "sage";
  assert.equal(v.validate(grp)[0].message, "unknown field `mode` (`mode` is the board's, written at the top, or a code item's own)");
  assert.equal(didYouMean("zzz", ["columns", "color"]), null);
  // (bounded work, PERF-619-1: a name past 64 characters gets no suggestion;
  // up to there, the same as a whole matrix would say)
  const a64 = "a".repeat(63) + "b", a65 = "a".repeat(64) + "b";
  assert.equal(didYouMean(a64, ["a".repeat(63) + "c"]), "a".repeat(63) + "c");
  assert.equal(didYouMean("a".repeat(62) + "ba", ["x", "a".repeat(62) + "ab"]), "a".repeat(62) + "ab");
  assert.equal(didYouMean("abcdefgh", ["badcfehg"]), null); // (four transpositions: past 2)
  assert.equal(didYouMean("abcdefgh", ["bacdefhg"]), "bacdefhg"); // (two)
  assert.equal(didYouMean(a65, ["a".repeat(64) + "c"]), null);
  const long = "a".repeat(4000), t0 = Date.now();
  assert.equal(didYouMean(long.slice(0, -1) + "b", [long, ...Array.from({ length: 1000 }, (_, i) => long + i)]), null);
  assert.ok(Date.now() - t0 < 1000);
  assert.throws(() => new SchemaValidator({ type: "object", minProperties: 1 }), /keyword minProperties at the root is not supported/);
});

test("a rule of the loader changed in doc.ts without the schema is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-schema-"));
  try {
    mkdirSync(join(dir, "web", "board"), { recursive: true });
    for (const f of ["web/board/doc.ts", "web/board/images.ts", "web/image-size.ts", "web/board-format.schema.json", "web/board/format-schema.ts"]) cpSync(join(repo, f), join(dir, f));
    const doc = readFileSync(join(dir, "web/board/doc.ts"), "utf8");
    writeFileSync(join(dir, "web/board/doc.ts"), doc.replace("w !== undefined && w >= 8 && w <= 4000", "w !== undefined && w >= 8 && w <= 8000"));
    let r = run(["--check"], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /the loader's rule "w !== undefined && w >= 8 && w <= 4000" is not there as written/);
    // (a regular expression is read from doc.ts: changed there, the schema is out of date)
    writeFileSync(join(dir, "web/board/doc.ts"), doc.replace("const IMAGE_NAME = /^[\\w-]{1,100}$/;", "const IMAGE_NAME = /^[\\w-]{1,80}$/;"));
    r = run(["--check"], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /(is|are) not as web\/board\/doc\.ts says/);
    assert.equal(run([], dir).status, 0);
    assert.match(readFileSync(join(dir, "web/board-format.schema.json"), "utf8"), /\{1,80\}/);
    // (a new field: in the schema, with its doc comment)
    writeFileSync(join(dir, "web/board/doc.ts"), doc.replace("  /** a label on it (plain text) */\n  label?: string;", "  /** a label on it (plain text) */\n  label?: string;\n  /** how wide */\n  width?: number;"));
    assert.equal(run([], dir).status, 0);
    const s = JSON.parse(readFileSync(join(dir, "web/board-format.schema.json"), "utf8"));
    assert.deepEqual(s.$defs.DocEdge.properties.width, { type: "number", minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE, description: "how wide" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
