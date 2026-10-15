import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// split, replace, dec2bin, dec2hex, bin2dec, hex2dec, sub2ind, ind2sub and
// mat2cell (lib/_matlab_more.py): what matlab-tests/test_more.m cannot
// compare with Octave (Octave lacks split and replace and string arrays,
// does not read the 0b and 0x prefixes, and truncates dec2bin's fractions
// towards zero), and the cases Sagebrush refuses.

const matlab = (code: string) =>
  execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--matlab", "-c", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// each expression's value, by disp, or its error's message
const values = (exprs: string[]) => {
  const out = matlab(exprs.map((e, k) => `fprintf('@@${k}\\n'); try, disp(${e}), catch err, disp(['ERROR ' err.message]), end`).join("\n") + "\n");
  return out.split(/@@\d+\n/).slice(1).map((s) => s.trim().split("\n").map((l) => l.trim()).join("|"));
};

test("split: its page's examples, the matched delimiters, the dimension, and cell arrays", () => {
  assert.deepEqual(values([
    'split(["Mary Butler"; "Santiago Marquez"; "Diana Lee"])',
    'split("/Users/jdoe/My Documents/Examples", "/")',
    'split("A horse! A horse! My kingdom for a horse!", [" " "!"])',
    'split(["Mary Butler"; "Santiago Marquez"; "Diana Lee"], " ", 1)',
    'size(split(["a b" "c d"]))',
    "split('a b c')",
    "split({'a b'; 'c d'})",
    "split('a--b-c', {'-', '--'})",
    "split('abc', 'x')",
  ]), [
    '"Mary"        "Butler"|"Santiago"    "Marquez"|"Diana"       "Lee"',
    '""|"Users"|"jdoe"|"My Documents"|"Examples"',
    '"A"|"horse"|""|"A"|"horse"|""|"My"|"kingdom"|"for"|"a"|"horse"|""',
    '"Mary"      "Santiago"    "Diana"|"Butler"    "Marquez"     "Lee"',
    "1     2     2",
    "{'a'}|{'b'}|{'c'}",
    "{'a'}    {'b'}|{'c'}    {'d'}",
    "{'a'     }|{0×0 char}|{'b'     }|{'c'     }",
    "{'abc'}",
  ]);
  const out = matlab(`[newStr, match] = split("bacon, lettuce, and tomato", ["and" "," " "]); disp(newStr'); disp(match')\n`);
  assert.equal(out.split("\n").map((l: string) => l.trim()).filter(Boolean).join("|"),
    '"bacon"    ""    "lettuce"    ""    ""    ""    "tomato"|","    " "    ","    " "    "and"    " "');
});

test("split refuses what its page leaves open, and text it cannot split evenly", () => {
  assert.deepEqual(values(["split('  a')", "split('a  b')", "split('a b ')", "split('a,b', '')", 'split(["a b" "c"])', 'split(["a b" "c d"], " ", 2)', "split(5)", "split(['ab'; 'cd'])"]).map((s) => s.slice(0, 50)), [
    "ERROR split: Sagebrush splits at whitespace only where it sep",
    "ERROR split: Sagebrush splits at whitespace only where it sep",
    "ERROR split: Sagebrush splits at whitespace only where it sep",
    "ERROR split: a delimiter must not be empty.",
    "ERROR split: every element of str must split into the same nu",
    "ERROR split: str has more than one element along dimension 2,",
    "ERROR split: str must be a string array, character vector or ",
    "ERROR split: str must be a character vector, not a character ",
  ].map((s) => s.slice(0, 50)));
});

test("replace: its page's examples, several substrings, and the type of str kept", () => {
  assert.deepEqual(values([
    'replace(["<ROOT_DIR>\\MyData\\data.tar.gz"; "<ROOT_DIR>\\MyScripts\\cleandata.m"], "<ROOT_DIR>", "C:\\MyProject")',
    "replace([\"Submission Date: 11/29/15\\r\"; \"Contact: john.smith@example.com\\r\\n\"], {'\\r\\n','\\r'}, '\\n')",
    "replace('cats and cats', 'cats', 'dogs')",
    "replace('aaa', 'aa', 'b')",
    "replace('abc', {'a', 'b'}, {'1', '2'})",
    "class(replace({'aaa', 'b'}, 'aa', 'x'))",
    'class(replace("abc", "b", ""))',
    "replace('abcabc', {'abc', 'ab'}, 'X')",
    "replace('abcabc', {'ab', 'abc'}, 'X')",
    "replace('abc', '', 'x')",
    "replace('abc', {'a', 'b'}, {'1', '2', '3'})",
  ]), [
    '"C:\\MyProject\\MyData\\data.tar.gz"|"C:\\MyProject\\MyScripts\\cleandata.m"',
    '"Submission Date: 11/29/15\\n"|"Contact: john.smith@example.com\\n"',
    "dogs and dogs",
    "ba",
    "12c",
    "cell",
    "string",
    "XX",
    "ERROR replace: 'ab' and 'abc' both begin at character 1; Sagebrush does not choose between them.",
    "ERROR replace: old must not be empty text.",
    "ERROR replace: new must be one piece of text or the same size as old.",
  ]);
});

test("join: its page's examples, an array of delimiters rebuilding split's text, cells, dim, and its refusals", () => {
  const out = matlab([
    'str = ["Carlos","Sada"; "Ella","Olsen"; "Diana","Lee"];',
    'str2 = ["x","y","z"; "a","b","c"];',
    'disp(join(str)); disp(join(str2, "-")); disp(join(str2, [" + "," = "; " - "," = "])); disp(join(str, 1));',
    '[newStr, match] = split("bacon, lettuce, and tomato", ["and" "," " "]); disp(join(newStr, match));',
    "c = join({'a', 'b'; 'c', 'd'}); disp(class(c)); disp(size(c)); disp(join({'a', 'b', 'c'}, {'+', '='}));",
    'disp(join(["a" "b"], "-", 2)); disp(join("abc"));',
  ].join("\n") + "\n");
  // (no trailing singleton dimensions in the result: N-D input, by default and along dim 3, and dim beyond the rank)
  const nd = matlab([
    "S = reshape(string(1:24), [2, 3, 4]); y = join(S, 3); disp(size(y)); disp(ndims(y)); disp(y(2, 3));",
    "y = join(S); disp(size(y)); disp(y(2, 3));",
    "C = reshape(cellstr(string(1:24)), [2, 3, 4]); z = join(C, 3); disp(size(z));",
    'w = join(["a", "b"; "c", "d"], 5); disp(size(w)); disp(ndims(w));',
    'v = split(["a b" "c d"]); disp(size(join(v, 3)));',
  ].join("\n") + "\n");
  assert.deepEqual(nd.split("\n").map((l: string) => l.trim()).filter(Boolean), [
    "2     3", "2", "6 12 18 24", "2     3", "6 12 18 24", "2     3", "2     2", "2", "1     2",
  ]);
  assert.deepEqual(out.split("\n").map((l: string) => l.trim()).filter(Boolean), [
    '"Carlos Sada"', '"Ella Olsen"', '"Diana Lee"', '"x-y-z"', '"a-b-c"', '"x + y = z"', '"a - b = c"',
    '"Carlos Ella Diana"    "Sada Olsen Lee"', "bacon, lettuce, and tomato", "cell", "2     1", "{'a+b=c'}", "a-b", "abc",
  ]);
  assert.deepEqual(values(["join('abc')", 'join(["a" "b" "c"], ["-" "+" "*"])', 'join(["a" "b"], "-", 0)', 'join(["a" "b"; "c" "d"], ["-"; "+"; "*"])', "join({1, 2})"]), [
    "ERROR join: str must be a string array or a cell array of character vectors, not char.",
    "ERROR join: delimiter must have 2 elements along dimension 2 (one fewer than str), and along each other dimension str's size or 1.",
    "ERROR join: dim must be a positive integer.",
    "ERROR join: delimiter must have 1 element along dimension 2 (one fewer than str), and along each other dimension str's size or 1.",
    "ERROR join: str must be text: a cell array's elements must be character vectors.",
  ]);
});

test("dimension, size and count arguments must be real, finite, integer scalars: refused, not truncated to a first element (CORR-E0C-2)", () => {
  assert.deepEqual(values([
    'join(["a","b";"c","d"], "-", [2, 1])', 'join(["a","b";"c","d"], "-", 2+3i)', 'join(["a","b";"c","d"], [2, 1])', 'join(["a","b";"c","d"], 2+3i)',
    'split("a b", " ", [1 2])', "zeros(2, [3 4])", "zeros(2+1i)", "zeros(Inf)", "flip(1:3, [2 1])", "nchoosek(5, [2 3])", "dec2bin(5, [8 9])",
    "cumsum([1 2], Inf)", "sum([1 2; 3 4], 2+3i)", "triu(magic(3), [1 2])",
    // (what stays valid: vector dims where MATLAB documents them, and a complex value with no imaginary part)
    "sum([1 2; 3 4], [2 1])", "circshift(1:4, [1 2])", "mean([1 2; 3 4], 2+0i)", "zeros([1 2])",
  ]), [
    "ERROR Expected a scalar dimension, not an array of 2 elements.", "ERROR Expected a real dimension, not a complex number.",
    "ERROR Expected a scalar dimension, not an array of 2 elements.", "ERROR Expected a real dimension, not a complex number.",
    "ERROR Expected a scalar dimension, not an array of 2 elements.", "ERROR Size inputs must be scalars.", "ERROR Size inputs must be real.",
    "ERROR Size inputs must be finite.", "ERROR Expected a scalar argument, not an array of 2 elements.", "ERROR Expected a scalar argument, not an array of 2 elements.",
    "ERROR Expected a scalar minDigits, not an array of 2 elements.", "ERROR Expected a finite dimension.", "ERROR Expected a real dimension, not a complex number.",
    "ERROR Expected a scalar argument, not an array of 2 elements.",
    "10", "3     4     1     2", "1.5000|3.5000", "0     0",
  ]);
});

test("dec2bin and dec2hex: fractions, two's complement, and their refusals", () => {
  assert.deepEqual(values([
    "dec2bin(-1.5)", "dec2bin(-2^63)", "dec2bin('a')", "dec2hex(2^64 - 2^12)",
    "dec2hex(10.5)", "dec2bin(2^64)", "dec2bin(int8(-1))", "dec2bin(NaN)", "dec2bin([])", "dec2bin(1+2i)", "dec2bin(5, -1)", "dec2bin({1})",
  ]), [
    "11111110", "1" + "0".repeat(63), "1100001", "FFFFFFFFFFFFF000",
    "ERROR dec2hex: D must contain integers: 10.5 has a fractional part.",
    "ERROR dec2bin: D's values must be at least intmin('int64') and less than 2^64.",
    "ERROR dec2bin: Sagebrush does not convert negative values of an integer class (MATLAB's documentation leaves their width open); convert them to double first.",
    "ERROR dec2bin: D must contain finite values.",
    "ERROR dec2bin: Sagebrush does not convert an empty array (MATLAB's documentation leaves the result open).",
    "ERROR dec2bin: D must be real.",
    "ERROR dec2bin: minDigits must be a nonnegative integer.",
    "ERROR dec2bin: D must be a numeric, logical or char array, not cell.",
  ]);
});

test("bin2dec and hex2dec: string arrays, the literals' prefixes and suffixes, and their refusals", () => {
  assert.deepEqual(values([
    'bin2dec(["1111111111" "1111010" "1110"])', "bin2dec('0b111')", "bin2dec('0b111s32')", "bin2dec('0b11111111s8')", "bin2dec('0B11u8')",
    'bin2dec(["1" "0"; "11" "10"])', 'hex2dec(["3FF" "7A" "E"])', "hex2dec('0xFF')", "hex2dec('0xFFs8')", "hex2dec('0xFFFFs16')",
    "bin2dec('1 0 1')", "bin2dec('102')", "bin2dec('')", "bin2dec('0b')", "bin2dec('0b111111111s8')", "bin2dec(repmat('1', 1, 54))", "bin2dec(5)", "hex2dec('G')",
  ]), [
    "1023         122          14", "7", "7", "-1", "3", "1     0|3     2", "1023         122          14", "255", "-1", "-1",
    "ERROR bin2dec: '1 0 1' is not binary text.",
    "ERROR bin2dec: '102' is not binary text.",
    "ERROR bin2dec: Sagebrush does not convert empty text (MATLAB's documentation leaves the result open).",
    "ERROR bin2dec: '0b' is not binary text.",
    "ERROR bin2dec: '0b111111111s8' does not fit in its int8 suffix's 8 bits.",
    "ERROR bin2dec: '" + "1".repeat(54) + "' has more than 53 binary digits.",
    "ERROR bin2dec: the text must be a character array, cell array of character vectors or string array, not double.",
    "ERROR hex2dec: 'G' is not hexadecimal text.",
  ]);
  // (a value of at least flintmax: a warning that it might not be exact)
  const r = require("node:child_process").spawnSync(process.execPath, [__dirname + "/../src/cli.js", "--matlab", "-c", "x = hex2dec('FFFFFFFFFFFFFFFF'); disp(x == 2^64)"], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), "1");
  assert.match(r.stderr, /^Warning: hex2dec: a value of at least flintmax \(2\^53\) might not be represented exactly as a double\.\n$/);
});

test("sub2ind and ind2sub: scalar subscripts expanding, and their refusals", () => {
  assert.deepEqual(values([
    "sub2ind([3 4], [1 2 3], 2)", "sub2ind([3 4], 2, [1; 4])",
    "sub2ind([3 4], 4, 1)", "sub2ind([3 4], 0, 1)", "sub2ind([3 4], 1.5, 1)", "sub2ind([3 4], [1 2], [1 2 3])", "sub2ind([3 4 2], 1, 2)",
    "sub2ind([3 4], 1, 2, 2)", "sub2ind([3 0], 1, 1)", "sub2ind([3 4])", "ind2sub([3 4], 0)", "ind2sub([3 4], 2.5)",
  ]), [
    "4     5     6", "2|11",
    "ERROR sub2ind: subscript 1 is out of range: at most 3.",
    "ERROR sub2ind: the subscripts must be positive integers.",
    "ERROR sub2ind: the subscripts must be positive integers.",
    "ERROR sub2ind: the subscripts must be the same size, or scalars.",
    "ERROR sub2ind: give one subscript for each of sz's 3 dimensions.",
    "ERROR sub2ind: subscript 3 is out of range: at most 1.",
    "ERROR sub2ind: sz must be a vector of positive integers.",
    "ERROR Not enough input arguments.",
    "ERROR ind2sub: ind must be positive integers.",
    "ERROR ind2sub: ind must be positive integers.",
  ]);
});

test("sub2ind and ind2sub: exact arithmetic beyond 2^52, and no scalar sz for ind2sub (R2024b)", () => {
  const out = matlab([
    "[r, c] = ind2sub([3, 1], 9007199254740994); fprintf('%.0f %.0f\\n', r, c);",
    "[r, c] = ind2sub([2^40 2^20], 2^60); fprintf('%.0f %.0f\\n', r, c);",
    "fprintf('%.0f\\n', sub2ind([2^40 2^20], 2^40, 2^20));",
    "[r, c] = ind2sub([6 1], [2 3 4]); disp([r; c]);",
    "fprintf('%.0f\\n', sub2ind(6, 4));",
    "try, [r, c] = ind2sub(6, [2 3 4]); catch e, disp(e.message), end",
    "try, sub2ind([2^40 2^20], 2, 2^20), catch e, disp(e.message), end",
    "try, [r, c] = ind2sub([3 2^60], 2^62 + 2^12); catch e, disp(e.message), end",
  ].join("\n") + "\n");
  assert.deepEqual(out.split("\n").map((l: string) => l.trim()).filter(Boolean), [
    "1 3002399751580332",
    "1099511627776 1048576",
    "1152921504606846976",
    "2     3     4",
    "1     1     1",
    "4",
    "ind2sub: sz must be a vector of positive integers with two or more elements; for a column of n elements, give [n 1].",
    "sub2ind: the result 1152920405095219202 is not exactly a double (above 2^53); Sagebrush does not round it.",
    "ind2sub: the result 1537228672809130667 is not exactly a double (above 2^53); Sagebrush does not round it.",
  ]);
});

test("mat2cell: string and struct arrays, and its refusals", () => {
  assert.deepEqual(values([
    'mat2cell(["a" "b" "c"], 1, [2 1])', "mat2cell(struct('a', {1, 2}), 1, [1 1])",
    "mat2cell(1:4, 1, [1 2])", "mat2cell(1:4, 1, [1 -1 4])", "mat2cell(1:4, 1, [1.5 2.5])", "mat2cell(magic(4), [2 2], [2 2], 2)",
  ]), [
    '{1×2 string}    {["c"]}', "{1×1 struct}    {1×1 struct}",
    "ERROR mat2cell: the distribution for dimension 2 adds up to 3, not to A's size there, 4.",
    "ERROR mat2cell: the distribution for dimension 2 must be a vector of nonnegative integers.",
    "ERROR mat2cell: the distribution for dimension 2 must be a vector of nonnegative integers.",
    "ERROR mat2cell: the distribution for dimension 3 adds up to 2, not to A's size there, 1.",
  ]);
});

test("N-D cell and string arrays display page by page, and a cell shows a string array's size", () => {
  const out = matlab("A = cat(3, {'a' 'b'; 'c' 'd'}, {'e' 'f'; 'g' 'h'})\ns = split([\"a b\" \"c d\"])\nc = {[\"a\" \"b\"], \"x\"}\nst = struct('f', [\"a\" \"b\"])\n");
  assert.equal(out, [
    "", "A =", "", "  2×2×2 cell array", "", "A(:,:,1) =", "", "    {'a'}    {'b'}", "    {'c'}    {'d'}", "", "",
    "A(:,:,2) =", "", "    {'e'}    {'f'}", "    {'g'}    {'h'}", "", "",
    "s =", "", "  1×2×2 string array", "", "s(:,:,1) =", "", '    "a"    "c"', "", "", "s(:,:,2) =", "", '    "b"    "d"', "", "",
    "c =", "", "  1×2 cell array", "", '    {1×2 string}    {["x"]}', "", "",
    "st = ", "", "  struct with fields:", "", "    f: [1×2 string]", "", "",
  ].join("\n"));
});
