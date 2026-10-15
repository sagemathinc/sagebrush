import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, constants } from "node:zlib";
import { createHash } from "node:crypto";

// PNG files (lib/_png.py, src/runtime/raster.ts, engine/raster): savefig's
// PNG and imread, against what CPython with matplotlib printed for the same
// programs (test/png-oracle.json, from test/png_oracle_gen.py: CI has no
// matplotlib), and the limits that bound the work for an untrusted file.
const TEST = __dirname + "/../../test/";
const oracle = JSON.parse(readFileSync(TEST + "png-oracle.json", "utf8"));
const run = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8", cwd: TEST });
const py = (code: string) => run(["-c", code]);

test("imread reads every kind of PNG as matplotlib does (and fails as it does)", () => {
  assert.equal(run([TEST + "png_imread_cases.py"]), oracle["png_imread_cases.py"]);
});

test("savefig's PNG has matplotlib's size, color type, resolution and text keys, and reads back as matplotlib's", () => {
  assert.equal(run([TEST + "png_savefig_cases.py"]), oracle["png_savefig_cases.py"]);
});

test("savefig's arguments act as matplotlib's: transparent and facecolor, axes patches, subplots, file objects, metadata", () => {
  assert.equal(run([TEST + "png_savefig_args_cases.py"]), oracle["png_savefig_args_cases.py"]);
});

// a PNG file from its IHDR fields and the IDAT data given
function crc32(b: Uint8Array): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function png(w: number, h: number, idat: Uint8Array, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", ihdr), ...extra, chunk("IDAT", idat), chunk("IEND", new Uint8Array())]);
}
const dir = mkdtempSync(join(tmpdir(), "sb-png-"));
const file = (name: string, b: Buffer) => {
  writeFileSync(join(dir, name), b);
  return JSON.stringify(join(dir, name));
};

test("imread refuses, before allocating it, an image wider or taller than 16384 or of more than 2**24 pixels", () => {
  const tiny = deflateSync(Buffer.from([0, 1, 2, 3]));
  const out = py(`
import matplotlib.pyplot as plt
for f in [${file("wide.png", png(16385, 1, tiny))}, ${file("big.png", png(4097, 4097, tiny))}, ${file("ok.png", png(1, 1, tiny))}]:
    try:
        print(plt.imread(f).shape)
    except ValueError as e:
        print("ValueError", e)
`);
  assert.equal(out, [
    "ValueError imread: a PNG image of 16385 x 1 pixels: Sagebrush reads at most 16384 on a side and 16777216 in all",
    "ValueError imread: a PNG image of 4097 x 4097 pixels: Sagebrush reads at most 16384 on a side and 16777216 in all",
    "(1, 1, 3)",
    "",
  ].join("\n"));
});

test("imread stops at the image's last row: the image data after it is not inflated", () => {
  // a file whose image data inflates to 64 MB more than its 2 pixels need,
  // read in no more time than a small file; and one whose image data goes on
  // with what is not deflate at all, an OSError as in matplotlib (the
  // decoder reads ahead within the chunk it has, never past what it can
  // keep)
  const rows = deflateSync(Buffer.from([0, 10, 20, 30, 0, 40, 50, 60]), { finishFlush: constants.Z_SYNC_FLUSH });
  const bomb = deflateSync(Buffer.concat([Buffer.from([0, 10, 20, 30, 0, 40, 50, 60]), Buffer.alloc(64 << 20)]), { level: 9 });
  const out = py(`
import time, matplotlib.pyplot as plt
plt.imread(${file("small.png", png(1, 2, deflateSync(Buffer.from([0, 10, 20, 30, 0, 40, 50, 60]))))})  # (the module compiled)
t = time.time()
a = plt.imread(${file("bomb.png", png(1, 2, bomb))})
print([round(v * 255) for v in a.ravel().tolist()], time.time() - t < 1)
try:
    plt.imread(${file("garbage.png", png(1, 2, Buffer.concat([rows, Buffer.alloc(64, 0xff)])))})
except OSError as e:
    print("OSError")
`);
  assert.equal(out, "[10, 20, 30, 40, 50, 60] True\nOSError\n");
});

test("imread caps the memory of a file's other chunks at 64 MB", () => {
  const text = (n: number) => chunk("tEXt", Buffer.concat([Buffer.from("Comment\0"), Buffer.alloc(n, 0x41)]));
  const ok = png(1, 1, deflateSync(Buffer.from([0, 1, 2, 3])), [text(1 << 20)]);
  const big = png(1, 1, deflateSync(Buffer.from([0, 1, 2, 3])), [text(40 << 20), text(40 << 20)]);
  const out = py(`
import matplotlib.pyplot as plt
for f in [${file("text-ok.png", ok)}, ${file("text-big.png", big)}]:
    try:
        print(plt.imread(f).shape)
    except ValueError as e:
        print("ValueError", e)
`);
  assert.equal(out, "(1, 1, 3)\nValueError imread: a PNG file whose chunks need more than the 64 MB Sagebrush gives them\n");
});

test("imread caps a file's chunks (HARD-6BC-2): empty image data chunks by the hundred thousand are refused promptly", () => {
  // at most 4096 + rows + bytes / 4096 chunks (engine/raster/src/pngio.rs,
  // max_chunks): the decoder's work for each, also an empty one, is bounded,
  // and an encoder's chunks of 8 KB or more, or one a row, are read
  const head = (w: number, h: number) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    return [Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", ihdr)];
  };
  const empty = chunk("IDAT", new Uint8Array());
  const end = chunk("IEND", new Uint8Array());
  const data = chunk("IDAT", deflateSync(Buffer.from([0, 1, 2, 3])));
  const many = (k: number) => Buffer.concat([...head(1, 1), ...Array(k).fill(empty), data, end]);
  // (a file of k empty chunks has k + 3; a 1 x 1 image's limit is 4096 + 1 + len / 4096)
  const limit = (k: number) => 4097 + Math.floor((many(0).length + 12 * k) / 4096);
  let k = 4000;
  while (k + 4 <= limit(k + 1)) k++;
  // a 64 x 512 image a row a chunk, as some encoders write it
  const rows = Buffer.concat(Array.from({ length: 512 }, (_, y) => Buffer.from([0, ...Array(192).fill(y % 256)])));
  const z = deflateSync(rows);
  const perRow = Buffer.concat([...head(64, 512), ...Array.from({ length: 512 }, (_, i) => chunk("IDAT", z.subarray(Math.floor((i * z.length) / 512), Math.floor(((i + 1) * z.length) / 512)))), end]);
  const out = py(`
import time, matplotlib.pyplot as plt
plt.imread(${file("warm.png", png(1, 1, deflateSync(Buffer.from([0, 1, 2, 3]))))})  # (the module compiled)
print(plt.imread(${file("per-row.png", perRow)}).shape)
print(plt.imread(${file("at-limit.png", many(k))}).shape)
for f in [${file("over-limit.png", many(k + 1))}, ${file("many.png", many(200000))}]:
    t = time.time()
    try:
        plt.imread(f)
    except ValueError as e:
        print("ValueError", str(e).split(",")[0], time.time() - t < 0.25)
`);
  assert.equal(out, [
    "(512, 64, 3)",
    "(1, 1, 3)",
    `ValueError imread: a PNG file of more than ${limit(k + 1)} chunks True`,
    `ValueError imread: a PNG file of more than ${limit(200000)} chunks True`,
    "",
  ].join("\n"));
});

test("nested opacity groups and clip paths are limited before their rasters are allocated (HARD-6BC-1)", () => {
  // (each keeps a raster the size of the picture while its content is drawn:
  // at most 16 nested, and 256 MB with the picture's)
  const out = py(`
import time, _sbraster
def nested(depth, size, attr):
    s = '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d"><defs><clipPath id="c"><rect width="9" height="9"/></clipPath></defs>' % (size, size)
    return s + ("<g %s>" % attr) * depth + '<rect width="1" height="1" fill="red"/>' + "</g>" * depth + "</svg>"
_sbraster.render(nested(1, 8, 'opacity="0.5"'), 1.0, 0, 0, "white", 100.0, [])  # (the module compiled)
for depth, size, attr in [(16, 512, 'opacity="0.5"'), (17, 512, 'opacity="0.5"'), (200, 512, 'clip-path="url(#c)"'), (4, 4096, 'opacity="0.5"')]:
    t = time.time()
    try:
        _sbraster.render(nested(depth, size, attr), 1.0, 0, 0, "white", 100.0, [])
        print(depth, "drawn")
    except ValueError as e:
        print(depth, "ValueError", e, time.time() - t < 1)
`);
  assert.equal(out, [
    "16 drawn",
    "17 ValueError opacity groups and clip paths nested more than 16 deep True",
    "200 ValueError opacity groups and clip paths nested more than 16 deep True",
    "4 ValueError a drawing of 4096 x 4096 pixels whose nested opacity groups and clip paths need more than 256 MB at once True",
    "",
  ].join("\n"));
});

test("a PNG module fetched from a URL runs only with the SHA-256 the page was built with, which it must have", () => {
  // (rasterBytes, in a process of its own: the URL branch, as the notebook's worker loads it)
  const wasm = readFileSync(__dirname + "/../../wasm/sagebrush-raster.wasm");
  const sha = createHash("sha256").update(wasm).digest("hex");
  const load = (hash: string | null) =>
    execFileSync(process.execPath, ["-e", `
const g = globalThis;
g.__SAGEBRUSH_RASTER_URL__ = "https://example.invalid/sagebrush-raster.wasm";
g.__SAGEBRUSH_FETCH_SYNC__ = () => { g.fetched = true; return new Uint8Array(require("fs").readFileSync(${JSON.stringify(__dirname + "/../../wasm/sagebrush-raster.wasm")})); };
${hash === null ? "" : `g.__SAGEBRUSH_RASTER_SHA256__ = ${JSON.stringify(hash)};`}
try { console.log(require(${JSON.stringify(__dirname + "/../src/runtime/raster.js")}).rasterBytes().length, !!g.fetched); }
catch (e) { console.log(e.message, !!g.fetched); }
`], { encoding: "utf8" }).trim();
  assert.equal(load(null), "the PNG module has no SHA-256 to check, so it is not loaded false");
  assert.equal(load("not a hash"), "the PNG module has no SHA-256 to check, so it is not loaded false");
  assert.equal(load("0".repeat(64)), "the PNG module fetched is not the one this page was built with true");
  assert.equal(load(sha), `${wasm.length} true`);
});

test("the PNG module is compiled only when a PNG is first written or read", () => {
  const out = py(`
import io, _sbraster, matplotlib.pyplot as plt
plt.plot([1, 2])
plt.savefig(io.StringIO(), format="svg")
print(_sbraster.loaded())
plt.savefig(io.BytesIO())
print(_sbraster.loaded())
`);
  assert.equal(out, "False\nTrue\n");
});

test("what PNG output and imread do not do is an error, and a character the font lacks is named", () => {
  const out = py(`
import io, matplotlib.pyplot as plt
plt.plot([1, 2])
for kw in [dict(format="pdf"), dict(format="jpg"), dict(bbox_inches="tight"), dict(orientation="portrait"), dict(format="svg", metadata={"a": "b"})]:
    try:
        plt.savefig(io.BytesIO(), **kw)
        print("no error", kw)
    except NotImplementedError as e:
        print("NotImplementedError", e)
plt.title("\\u3042 and \\u2603")
try:
    plt.savefig(io.BytesIO())
except NotImplementedError as e:
    print("NotImplementedError", e)
for f in [${file("x.jpg", Buffer.from("\xff\xd8\xff\xe0 a JPEG", "latin1"))}, "http://example.com/a.png"]:
    try:
        plt.imread(f)
    except (NotImplementedError, ValueError, OSError) as e:
        print(type(e).__name__, str(e)[:60])
try:
    plt.imread(io.BytesIO(b"\\xff\\xd8\\xff\\xe0 a JPEG"), format="jpeg")
except NotImplementedError as e:
    print("NotImplementedError", e)
try:
    plt.imread(io.BytesIO(b"\\xff\\xd8\\xff\\xe0 a JPEG"))
except SyntaxError as e:
    print("SyntaxError", e)
`);
  assert.equal(out, [
    "NotImplementedError savefig: Sagebrush saves PNG and SVG files, not pdf",
    "NotImplementedError savefig: Sagebrush saves PNG and SVG files, not jpg",
    "NotImplementedError savefig: bbox_inches='tight' is not implemented in Sagebrush",
    "NotImplementedError savefig: orientation is not implemented in Sagebrush",
    "NotImplementedError savefig: metadata for SVG is not implemented in Sagebrush",
    "NotImplementedError savefig: PNG output in Sagebrush supports Latin-1, Greek and common math symbols, and this figure has 'あ' (U+3042), '☃' (U+2603); save it as SVG (a .svg file name) to keep them",
    "NotImplementedError imread: Sagebrush reads PNG files only, and this file is not",
    "ValueError Please open the URL for reading and pass the result to Pillo",
    "NotImplementedError imread: Sagebrush reads PNG files only, and this file is not one (.jpeg)",
    "SyntaxError not a PNG file",
    "",
  ].join("\n"));
});
