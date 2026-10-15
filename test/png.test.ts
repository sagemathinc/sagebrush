import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, constants } from "node:zlib";

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
