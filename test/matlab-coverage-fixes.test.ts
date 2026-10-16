import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Wrong answers found by running external MATLAB code (the coverage corpora),
// each fixed to what the function's documentation page shows, or to Octave's
// value where the page shows none (asin and acos beyond 1).

const run = (code: string, env: Record<string, string> = {}) => {
  const d = mkdtempSync(join(tmpdir(), "sb-cov-"));
  try {
    return execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--matlab", "-c", code],
      { cwd: d, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
};
// (the CLI's notes of the figures it draws are not MATLAB's output)
const lines = (s: string) => s.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "" && !/^(Plot: |Saved |\(figures are removed )/.test(l.trim()));

test("sets, comparisons and text: the pages' values", () => {
  const out = run([
    "[~, loc] = ismember([5 3 4 2], [2 4 4 4 6 8], 'legacy'); fprintf('%g ', loc); fprintf('\\n');",
    "[tf, loc] = ismember([5 NaN NaN], [5 NaN NaN]); fprintf('%g ', tf, loc); fprintf('\\n');",
    "[C, ia, ib] = union([5 7 1], [3 1 1], 'legacy'); fprintf('%g ', C, ia, ib); fprintf('| %d %d\\n', size(ia, 1), size(ib, 1));",
    "fprintf('%g ', unique([5 8 NaN NaN], TreatMissingAsDistinct=false)); fprintf('\\n');",
    "fprintf('%d %d\\n', isequal(\"foo\", 'foo'), isequal('foo', \"foo\"));",
    "fprintf('%d ', isstrprop([77 65 84 76 65 66], 'alpha')); fprintf('\\n');",
    "fprintf('%.4f ', std([1.77 -0.005 NaN -2.95; NaN 0.34 NaN 0.19], 'omitmissing')); fprintf('\\n');",
    "fprintf('%.4f ', var([1.77 -0.005 NaN -2.95; NaN 0.34 NaN 0.19], 'omitnan')); fprintf('\\n');",
    "fprintf('[%s]\\n', strrep('abc 2 def 22 ghi 222 jkl 2222', '22', '*'));",
    "fprintf('[%s]\\n', sprintf(' %3$s %2$s %1$s', 'X', 'Y', 'Z'));",
    "[p, n, e] = fileparts(\"/home/jsmith/.cshrc\"); fprintf('[%s][%s][%s]\\n', p, n, e);",
    "B = sort([\"Santos\",\"Burns\"; \"Jones\",\"Morita\"; \"Petrov\",\"Adams\"]); fprintf('%s ', B); fprintf('\\n');",
    "B = sort([\"Santos\",\"Burns\"; \"Jones\",\"Morita\"; \"Petrov\",\"Adams\"], 2); fprintf('%s ', B); fprintf('\\n');",
    "k = strfind('abc', 'x'); fprintf('%d %d\\n', size(k));",
    "T = cell2struct({1; 2}, [\"x\" \"y\"]); fprintf('%d %d\\n', T.x, T.y);",
  ].join("\n") + "\n");
  assert.deepEqual(lines(out), [
    "0 0 4 1",
    "1 0 0 1 0 0",
    "1 3 5 7 1 2 3 1 | 1 1",
    "5 8 NaN",
    "1 1",
    "1 1 1 1 1 1",
    "0.0000 0.2440 NaN 2.2203",
    "0.0000 0.0595 NaN 4.9298",
    "[abc 2 def * ghi ** jkl ***]",
    "[ Z Y X]",
    "[/home/jsmith][][.cshrc]",
    // (each column sorted, then along the rows: the pages' B, column by column)
    "Jones Petrov Santos Adams Burns Morita",
    "Burns Jones Adams Santos Morita Petrov",
    "0 0",
    "1 2",
  ]);
});

test("numbers: classes kept, branch cuts, transforms, diagonals, 'like' prototypes", () => {
  const out = run([
    "m = median(int8(1:4)); fprintf('%s %d\\n', class(m), m);",
    "p = primes(uint16(12)); fprintf('%s ', class(p)); fprintf('%d ', p); fprintf('\\n');",
    "c = nchoosek(uint16([10 20 30]), 2); fprintf('%s %d\\n', class(c), c(3, 2));",
    "y = atanh([2 -3 1+2i]); fprintf('%.4f %.4f %.4f %.4f\\n', real(y(1)), imag(y(1)), real(y(2)), imag(y(2)));",
    "fprintf('%.4f ', real([asin(2) acos(2) acos(-2)]), imag([asin(2) acos(2) acos(-2)])); fprintf('\\n');",
    "x = ifft(fft([1 2 3 4 5])); fprintf('%d\\n', isreal(x));",
    "X = ifft2([3+1e-15i 5; 5 3], 'symmetric'); fprintf('%d %g %g %g %g\\n', isreal(X), X);",
    "A = full(spdiags([1 -2 1], -1:1, 4, 4)); fprintf('%g ', A); fprintf('\\n');",
    "x = [1 0; 0 0] \\ [1; 1]; fprintf('%g ', x); fprintf('\\n');",
    "h = histc([1; 2; 2; 5], 0:2:6); fprintf('%d %d|', size(h)); h = histc([1 2 2 5], 0:2:6); fprintf('%d %d\\n', size(h));",
    "d = eps('like', single(1i)); fprintf('%s %d\\n', class(d), isreal(d));",
    "r = realmax('single'); fprintf('%s %g %g\\n', class(r), double(r), double(flintmax('single')));",
    "fprintf('%d %d %d\\n', issparse(realmax('like', sparse(1))), isreal(zeros(2, 'like', 1i)), isreal(eye(2, 'like', 1i)));",
  ].join("\n") + "\n");
  assert.deepEqual(lines(out), [
    "int8 3",
    "uint16 2 3 5 7 11",
    "uint16 30",
    // (atanh's page: atanh(2) = 0.5493 + 1.5708i, atanh(-3) = -0.3466 - 1.5708i)
    "0.5493 1.5708 -0.3466 -1.5708",
    // (Octave's: asin(2) = 1.5708 - 1.3170i, acos(2) = 1.3170i, acos(-2) = 3.1416 - 1.3170i)
    "1.5708 0.0000 3.1416 -1.3170 1.3170 -1.3170",
    "1",
    "1 4 0 0 -1",
    "-2 1 0 0 1 -2 1 0 0 1 -2 1 0 0 1 -2",
    "1 Inf",
    "4 1|1 4",
    "single 0",
    "single 3.40282e+38 1.67772e+07",
    "1 0 0",
  ]);
});

test("transforms page by page, 'symmetric' ignoring the second half, cuts at infinity, warning modes", () => {
  const out = run([
    // (fft2 and ifft2 transform each page apart, as ifft2's page says)
    "A = zeros(2,2,3); A(1,1,1) = 1; A(1,1,2) = 2; A(1,1,3) = 3; fprintf('%g ', fft2(A)); fprintf('\\n');",
    "Y = zeros(2,2,3); Y(1,1,2) = 1i; Y(1,1,3) = -1i; fprintf('%g ', imag(ifft2(Y))); fprintf('\\n');",
    "A = rand(3,4,2,2); B = fft2(A); e = 0; for p = 1:2, for q = 1:2, e = max(e, max(max(abs(B(:,:,p,q) - fft(fft(A(:,:,p,q)).').')))); end, end; " +
      "C = ifft2(B); F = fftn(A); fprintf('%d %d %d %d\\n', e < 1e-12, isreal(C), isreal(ifftn(F)), isequal(F(2,3,2,1), conj(F(3,3,2,1))));",
    // ('symmetric': the second half of the spectrum ignored)
    "Y = [0 1 0 9]; fprintf('%g ', ifft(Y, 'symmetric'), ifft2(Y, 'symmetric'), ifftn(Y, 'symmetric')); fprintf('\\n');",
    "fprintf('%.15g ', ifft2([0 1 0 1+1e-10], 'symmetric')); fprintf('\\n');",
    "Y = fft2(magic(4)); Y(4,4) = 99; fprintf('%d\\n', max(max(abs(ifft2(Y, 'symmetric') - magic(4)))) < 1e-12);",
    "P = ifft2(fft2(magic(3)), 5, 4, 'symmetric'); Q = ifftn(fftn(magic(4)), [2 2], 'symmetric'); fprintf('%d %d %d %d %d\\n', size(P), isreal(P), size(Q, 1), isreal(Q));",
    "clear Y; Y(:,:,1) = [1e-15*1i 0; 1 0]; Y(:,:,2) = [0 1; 0 1]; fprintf('%g ', ifftn(Y, 'symmetric')); fprintf('\\n');",
    // (no overflow or underflow making the symmetry exact)
    "fprintf('%.17g ', fft2(3e307*ones(2)), fftn(3e307*ones(2))); fprintf('%g ', real(fft2([5e-324 0; 0 0]))); fprintf('\\n');",
    // (Octave's values at infinity: the real part stays 0, pi or pi/2)
    "fprintf('%g ', real(acos([Inf -Inf])), imag(acos([Inf -Inf])), real(asin([Inf -Inf])), imag(asin([Inf -Inf]))); fprintf('\\n');",
    "z = acos([Inf 1i]); fprintf('%g %g\\n', real(z(1)), imag(z(1)));",
    "warning('off', 'backtrace'); s = warning('query', 'backtrace'); t = warning('on', 'backtrace'); warning(t); u = warning('query', 'backtrace'); " +
      "v = warning('query', 'verbose'); fprintf('%s %s %s %s %s\\n', s.state, t.state, u.state, v.identifier, v.state);",
    "try, warning('on', 'verbose'), catch e, disp(e.message), end",
  ].join("\n"));
  assert.deepEqual(lines(out), [
    "1 1 1 1 2 2 2 2 3 3 3 3",
    "0 0 0 0 0.25 0.25 0.25 0.25 -0.25 -0.25 -0.25 -0.25",
    "1 1 1 1",
    "0.5 0 -0.5 0 0.5 0 -0.5 0 0.5 0 -0.5 0",
    "0.5 0 -0.5 0",
    "1",
    "5 4 1 2 1",
    "0.375 -0.125 -0.125 -0.125 -0.125 -0.125 0.375 -0.125",
    "1.1999999999999999e+308 0 0 0 1.1999999999999999e+308 0 0 0 4.94066e-324 4.94066e-324 4.94066e-324 4.94066e-324",
    "0 3.14159 Inf -Inf 1.5708 -1.5708 -Inf Inf",
    "0 Inf",
    "off off off verbose off",
    "warning: the \"verbose\" display mode is not supported in Sagebrush.",
  ]);
});

test("files, warnings, errors and comma-separated lists", () => {
  const out = run([
    "fid = fopen('out.txt', 'w'); n = fprintf(fid, '%5d %5d %5d %5d\\n', magic(4)); fclose(fid); fprintf('%d %d %d\\n', fid > 2, n, isfile('out.txt'));",
    "type out.txt",
    "[fid, msg] = fopen('nope.txt'); fprintf('%d [%s]\\n', fid, msg);",
    "fprintf('%d ', isfile([\"out.txt\" \"nope.txt\"])); fprintf('\\n');",
    "s = warning('off', 'MATLAB:singularMatrix'); x = [1 2; 2 4] \\ [1; 2]; warning(s); [msg, id] = lastwarn; fprintf('[%s] [%s] [%s]\\n', s.state, id, msg);",
    "warning('off'); warning",
    "warning('on'); warning('off', 'MATLAB:singularMatrix'); warning",
    "warning('on');",
    "try, surf, catch err, fprintf('%s|%s\\n', err.message, err.identifier), end",
    "S.a = []; S(2).a = []; S(3).a = []; [S.a] = deal(10, 20, 30); fprintf('%d ', S.a); fprintf('\\n');",
    "[S(2:3).a] = deal(7, 8); fprintf('%d ', S.a); fprintf('\\n');",
    "c = {1, [2 3]};",
    "c{:}",
  ].join("\n") + "\n");
  assert.deepEqual(lines(out), [
    "1 96 1",
    "   16     5     9     4",
    "    2    11     7    14",
    "    3    10     6    15",
    "   13     8    12     1",
    "-1 [No such file or directory]",
    "1 0",
    // (the warning was off: lastwarn still has it, as lastwarn's page shows a disabled warning's)
    "[on] [MATLAB:singularMatrix] [Matrix is singular to working precision.]",
    'All warnings have the state "off".',
    'The default warning state is "on". Warnings not set to the default are',
    "State  Warning Identifier",
    "    off  MATLAB:singularMatrix",
    "Not enough input arguments.|MATLAB:narginchk:notEnoughInputs",
    "10 20 30",
    "10 7 8",
    // (c{:} alone: each element as ans, as MATLAB shows idx{:})
    "ans =",
    "     1",
    "ans =",
    "     2     3",
  ]);
});

test("display: struct fields since R2021b, cells of strings, empties, and the documentation's layout", () => {
  const out = run([
    "s.x = linspace(0, 1, 11); s.m = {'Jan', 'Feb', 'Mar'}; s.d = linspace(0, 2*pi);",
    "s",
    "k = zeros(1, 0)",
    "c = zeros(0, 1)",
    "T = {\"highs\", 1; \"lows\", 2}",
  ].join("\n") + "\n");
  const l = lines(out).map((x) => x.trim());
  assert.ok(l.includes("x: [0 0.1000 0.2000 0.3000 0.4000 0.5000 0.6000 0.7000 0.8000 0.9000 1]"), l.join("\n"));
  assert.ok(l.includes("m: {'Jan'  'Feb'  'Mar'}"), l.join("\n"));
  assert.ok(l.some((x) => /^d: \[0 0\.0635 0\.1269 .* … \]$/.test(x)), l.join("\n"));
  assert.ok(l.includes("1×0 empty double row vector") && l.includes("0×1 empty double column vector"), l.join("\n"));
  assert.ok(l.includes('{["highs"]}    {[1]}') && l.includes('{["lows" ]}    {[2]}'), l.join("\n"));
  // (the documentation's layout: warnings in line with the output, a long field and a wide cell whole)
  const doc = lines(run([
    "x = [1 2; 2 4] \\ [1; 2];",
    "s.d = linspace(0, 2*pi)",
    "c = {'accidents.mat', 'airlineResults.mat', 'census.mat', 'earth.mat'}",
  ].join("\n") + "\n", { SAGEBRUSH_MATLAB_DISPLAY: "doc" }));
  assert.equal(doc[0], "Warning: Matrix is singular to working precision.");
  assert.ok(doc.some((x) => x.trim().startsWith("d: [0 0.0635 0.1269") && x.trim().endsWith(" 6.2832]")), doc.join("\n"));
  assert.ok(doc.some((x) => x.includes("{'accidents.mat'}") && x.includes("{'earth.mat'}")), doc.join("\n"));
});

test("[S(I,J).f] = ...: the comma-separated count admitted from the subscripts, before positions or outputs", () => {
  const t0 = Date.now();
  const out = run([
    "S.a = 0; I = [1 1]; [S(I,I).a] = deal(5); fprintf('%d %d\\n', S.a, numel(S));",
    "T = struct('a', {1, 2, 3}); [T([3 1]).a] = deal(30, 10); fprintf('%d ', T.a); fprintf('\\n');",
    // (repeated subscripts into a scalar struct: 400^2 and 10^10 outputs, refused at once)
    "S.a = 0; I = ones(1, 400); try, [S(I,I).a] = deal(1); catch e, disp(e.message), end",
    "I = ones(1, 1e5); try, [S(I,I).a] = deal(1); catch e, disp(e.message), end",
  ].join("\n") + "\n");
  assert.deepEqual(lines(out), [
    "5 1",
    "10 2 30",
    "[S(...).f] = ... with 160000 comma-separated outputs is beyond Sagebrush's limit of 100000.",
    "[S(...).f] = ... with 10000000000 comma-separated outputs is beyond Sagebrush's limit of 100000.",
  ]);
  assert.ok(Date.now() - t0 < 30000, "the refusals are immediate");
});

test("fft2, ifft2, fftn and ifftn refuse a transform size that is not a positive integer (CORR-0A8-1)", () => {
  const out = lines(run([
    ...["fft2(ones(2),-1,2)", "ifft2(ones(2),2,-1)", "fftn(ones(2),[-1 2])", "ifftn(ones(2),[2 -1])", "fft2(ones(2),1.5,2)", "fftn(ones(2),[0 2])"]
      .map((c) => `try, x = ${c}; disp('ran'), catch e, disp(e.message), end`),
    "disp(mat2str(size(fft2(ones(2), 3, 1))))",
    // (the sizes are checked before X is made dense: a large sparse X is refused at once)
    "S = sparse(100000, 100000); S(1, 1) = 1; try, x = fft2(S, -1, 2); disp('ran'), catch e, disp(e.message), end",
    "try, x = fft2(S, struct(), 2); disp('ran'), catch e, disp(e.message), end",
    "try, x = ifftn(S, {2 2}, 'symmetric'); disp('ran'), catch e, disp(e.message), end",
  ].join("\n")));
  assert.deepEqual(out, [
    "Invalid number of FFT data points (-1) specified.", "Invalid number of FFT data points (-1) specified.",
    "Invalid number of FFT data points (-1) specified.", "Invalid number of FFT data points (-1) specified.",
    "Invalid number of FFT data points (1.5) specified.", "Invalid number of FFT data points (0) specified.",
    "[3 1]",
    "Invalid number of FFT data points (-1) specified.",
    "Expected a numeric value, not struct.",
    "Expected a numeric value, not cell.",
  ]);
});

test("errors that leaked from the implementation: the documented forms, or MATLAB's errors and explicit refusals", () => {
  const out = run([
    "X = [1 2.5 7 10]; Y = [5.2 7.7 9.6 13.2; 4.8 7.0 10.5 14.5; 4.9 6.5 10.2 13.8];",
    "fprintf('%.4f ', trapz(X, Y, 2)); fprintf('|%g %g %g\\n', trapz([1 2 3]), trapz(0.5, [1 2 3]), trapz([1 2 3]', 1));",
    "z = log10([0 1i]); fprintf('%g %g %.4f\\n', real(z(1)), imag(z(1)), imag(z(2)));",
    "[m, s] = regexp('bat cat coat', 'c[aeiou]+t', 'match', 'split', 'forceCellOutput'); fprintf('%s %d %d\\n', class(m), numel(m{1}), numel(s{1}));",
    "t = regexp('01/11 02/20', '(?<m>\\d+)/(?<d>\\d+)', 'names'); fprintf('%d %d %s\\n', size(t), t(2).d);",
    "fprintf('%d\\n', numel(regexp(sprintf('abc\\n de'), '.*', 'match', 'once')));",
    "fprintf('%d\\n', numel(regexp('abc', 'x*', 'match')));",
    "try, regexp('a', 'a', 'bogus'), catch e, disp(e.message), end",
    "try, intmax('int8', 'like', 1), catch e, disp(e.message), end",
    "try, foo = sortrows([3 1; 1 2], 1, 'descend', 'x'); catch e, disp(e.message), end",
    "try, isstrprop(), catch e, disp(e.message), end",
    "b = bar([1 2 3], [2 3 6; 11 23 26]); fprintf('%d %d\\n', numel(b), numel(b(1).YData));",
  ].join("\n") + "\n");
  assert.deepEqual(lines(out), [
    // (trapz's page: 82.8000, 85.7250, 82.1250)
    "82.8000 85.7250 82.1250 |4 2 4",
    "-Inf 0 0.6822",
    "cell 2 3",
    "1 2 20",
    "7",
    // (zero-length matches are left out, as regexp's page says of the default 'noemptymatch')
    "0",
    "regexp: the option 'bogus' is not supported in Sagebrush.",
    "intmax: specify the name of an integer class, or \"like\", p.",
    "sortrows with 4 inputs is not supported in Sagebrush (it takes at most 2 here).",
    "Not enough input arguments.",
    // (bar's page: x = [1 2 3] with a 2-by-3 vals is two series of three bars)
    "2 3",
  ]);
});

test("more outputs and string arrays: log2, mode, polyfit, deal into cells, strjoin, strcat, fileparts, cellfun", () => {
  const out = run([
    // (log2's page: [F,E] = log2([1 pi -3 eps realmax realmin]); zeros, Inf and NaN as it says)
    "[F, E] = log2([1 pi -3 eps realmax realmin 0 Inf NaN]); fprintf('%.4f ', F); fprintf('| '); fprintf('%d ', E); fprintf('\\n');",
    "try, [F, E] = log2(1i), catch e, disp(e.message), end",
    // (mode's page: [M,F] = mode([3 3 1 4; 0 0 1 1; 0 1 2 4]); NaN ignored, the class kept)
    "[M, F] = mode([3 3 1 4; 0 0 1 1; 0 1 2 4]); fprintf('%d ', M, F); fprintf('\\n');",
    "[M, F, C] = mode([1 2 2 3 3 NaN NaN NaN]); fprintf('%d %d %d %d %s\\n', M, F, C{1}, class(C));",
    "[M, F, C] = mode(int8([1 1 2 2; 3 3 3 4]), 2); fprintf('%s %d %d %d %d %d\\n', class(M), M, F, numel(C{1}));",
    "v = intmax(like=int16(4)); w = intmin('like', uint8(1)); fprintf('%s %d %s %d\\n', class(v), v, class(w), w);",
    // (complex integers are not represented: refused, not their imaginary parts dropped)
    "try, p = int8([-12 3+2i 2]), catch e, disp(e.message), end",
    "try, t = int16(2) * 1i, catch e, disp(e.message), end",
    // (polyfit's page: Normalize=true, then polyval(coeffsNorm, x, [], centerScale))
    "x = 1750:25:2000; y = 1e6*[791 856 978 1050 1262 1544 1650 2532 6122 8170 11560];",
    "[cn, ~, cs] = polyfit(x, y, 5, Normalize=true); yf = polyval(cn, x, [], cs); fprintf('%.4f %.4f %.4e %.4e\\n', cs, cn(1), max(abs(yf - y)));",
    "[p0, ~, cs0] = polyfit(1:5, [1 4 9 16 25], 2, Normalize=false); fprintf('%.4f %d %d\\n', p0(1), cs0);",
    "try, polyfit(1:3, 1:3, 1, Weights=[1 1 1]), catch e, disp(e.message), end",
    // (deal's page: [C{:}] = deal(A1,A2,A3) and [D{1:3}] = deal(A1,A2,A3))
    "c = {0}; I = ones(1, 1e5); try, [c{I,I}] = deal(1); catch e, disp(e.message), end",
    "c = cell(1, 2); try, [c{1:3}] = deal(1, 2, 3); catch e, disp(e.message), end",
    "C = cell(1,3); [C{:}] = deal(100, \"foo\", 1:5); D = cell(1,5); [D{1:3}] = deal(100, \"foo\", 1:5); fprintf('%d %s %d %d %d\\n', C{1}, C{2}, numel(C{3}), numel(D{3}), isempty(D{4}));",
    // (strjoin's page: one fewer delimiters than C, as literal text; a string array gives a string)
    "[m, s] = regexp('She sells sea shells by the seashore.', '[Ss]h.', 'match', 'split'); disp(strjoin(s, m));",
    "a = strjoin({'a','b','c'}, {',',' '}); b = strjoin([\"x\",\"y\"], '-'); fprintf('%s %s %s\\n', a, class(b), b);",
    // (strcat's page: string arrays element by element; a character vector's trailing whitespace removed)
    "s = strcat([\"John \",\"Mary \"], [\"Smith\",\"Jones\"]); t = strcat(s, ', M.D.'); u = strcat(\"a \", 'b  ', \"c\"); fprintf('%s|', s, t, u); fprintf('\\n');",
    // (fileparts's page: a 2-by-2 string array)
    "[p, n, e] = fileparts([\"H:/user1/matlab/file1.txt\", \"H:/user2/matlab/file2.txt\"; \"H:/user3/matlab/file3.txt\", \"H:/user4/matlab/file4.txt\"]); fprintf('%s %d %d %s %s\\n', class(p), size(n), p(2,1), e(1,2));",
    // (cellfun's page: a string array's elements as character vectors)
    "B = cellfun(@(x) x(1:3), [\"Saturday\", \"Sunday\"], 'UniformOutput', false); fprintf('%s %s %s\\n', class(B), B{:});",
  ].join("\n") + "\n");
  assert.deepEqual(lines(out), [
    "0.5000 0.7854 -0.7500 0.5000 1.0000 0.5000 0.0000 Inf NaN | 1 2 2 -51 1024 -1021 0 0 0",
    "log2: the two-output syntax does not accept complex input.",
    "0 0 1 4 2 1 2 2",
    "2 2 2 3 cell",
    "int8 1 3 2 3 2",
    "int16 32767 uint8 0",
    "Complex int8 values are not supported in Sagebrush.",
    "Complex int16 values are not supported in Sagebrush.",
    // (numpy's least-squares fit of the normalized x gives the same coefficients and residual)
    "1875.0000 82.9156 -5.9431e+08 6.9883e+08",
    "1.0000 0 1",
    "polyfit: the option Weights is not supported in Sagebrush.",
    "[C{...}] = ... with 10000000000 comma-separated outputs is beyond Sagebrush's limit of 100000.",
    "[C{...}] = ... beyond the end of C (growing it) is not supported in Sagebrush.",
    "100 foo 5 5 1",
    "She sells sea shells by the seashore.",
    "a,b c string x-y",
    "John Smith|Mary Jones|John Smith, M.D.|Mary Jones, M.D.|a bc|",
    "string 2 2 H:/user3/matlab .txt",
    "cell Sat Sun",
  ]);
});

test("format rat in the documentation's layout: no size in the heading, as beta's, log2's and rat's pages show", () => {
  const out = run("format rat\n[F, E] = log2([1 pi -3])\nformat short\nY = [1 2 3]\n", { SAGEBRUSH_MATLAB_DISPLAY: "doc" });
  assert.deepEqual(lines(out).map((x) => x.trim()), ["F =", "1/2          355/452         -3/4", "E =", "1              2              2", "Y = 1×3", "1     2     3"]);
});

test("mode keeps a logical class in M and C; intmax/intmin 'like' a 64-bit integer refuse a limit Sagebrush can't hold exactly (CORR-D252-1, CORR-D252-2)", () => {
  const out = lines(run([
    "[m, f, c] = mode(logical([1 0 1 0])); fprintf('%s %s %s %s %d\\n', class(m), class(c{1}), class(f), mat2str(c{1}), f);",
    "try, x = intmax('like', uint64(1)); disp('ran'), catch e, disp(e.message), end",
    "try, x = intmax('like', int64(1)); disp('ran'), catch e, disp(e.message), end",
    "fprintf('%s %d %s %d\\n', class(intmin('like', int64(1))), intmin('like', int64(1)) == -2^63, class(intmin('like', uint64(1))), intmin('like', uint64(1)));",
    "fprintf('%d %d\\n', intmax('like', int8(1)), intmin('like', uint16(1)));",
  ].join("\n")));
  assert.deepEqual(out, [
    "logical logical double [false;true] 2",
    "intmax(\"like\", p) for uint64 is not supported: Sagebrush's 64-bit integers are not exact at 18446744073709551615.",
    "intmax(\"like\", p) for int64 is not supported: Sagebrush's 64-bit integers are not exact at 9223372036854775807.",
    "int64 1 uint64 0",
    "127 0",
  ]);
});
