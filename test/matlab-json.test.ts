import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// jsonencode and jsondecode in MATLAB mode (lib/_matlab_json.py), where MATLAB's documentation says what Octave does
// differently (struct arrays nested, string arrays, matlab.lang.makeValidName's names, PrettyPrint's layout), the
// errors, the bounds on untrusted JSON text, and a fitted result exported as JSON (a task an agent ran).
// matlab-tests/test_json.m checks the rest against Octave.

const cli = join(__dirname, "..", "src", "cli.js");

function run(src: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sb-mjson-"));
  writeFileSync(join(dir, "main.m"), src);
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

test("jsonencode as MATLAB documents it: struct arrays nested, string arrays, PrettyPrint", () => {
  const r = run([
    "disp(jsonencode(struct('a', {1, 2; 3, 4})))",
    "disp(jsonencode([\"a\", \"b\"; \"c\", \"d\"]))",
    "disp(jsonencode([\"one\"; \"two\"]))",
    "s = struct('Width', 800, 'Height', 600, 'Title', 'View from the 15th Floor', 'Animated', false, 'IDs', [116, 943, 234, 38793]);",
    "disp(jsonencode(s, 'PrettyPrint', true))",
    "disp(isequal(jsonencode(s, PrettyPrint=true, ConvertInfAndNaN=true), jsonencode(s, 'PrettyPrint', true)))",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, [
    '[[{"a":1},{"a":2}],[{"a":3},{"a":4}]]',
    '[["a","b"],["c","d"]]',
    '["one","two"]',
    "{",
    '  "Width": 800,',
    '  "Height": 600,',
    '  "Title": "View from the 15th Floor",',
    '  "Animated": false,',
    '  "IDs": [',
    "    116,",
    "    943,",
    "    234,",
    "    38793",
    "  ]",
    "}",
    "   1",
    "",
  ].join("\n"));
});

test("jsondecode as MATLAB documents it: names made valid as matlab.lang.makeValidName makes them", () => {
  const r = run([
    "v = jsondecode('{\"1a\":1,\"b c\":2,\"_x\":3,\"for\":4,\"a-b\":5}');",
    "disp(strjoin(fieldnames(v)', ' '))",
    "v = jsondecode(\"[1, 2]\"); disp(size(v))",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "x1a bC x_x xFor a_b\n     2     1\n");
});

test("jsonencode and jsondecode refuse what they can't do; JSON text is bounded before it is parsed", () => {
  const m = (code: string, env: Record<string, string> = {}) => {
    const r = run(`try, ${code}, disp('PASS'), catch e, disp([e.identifier '|' e.message]), end`, env);
    assert.equal(r.status, 0, r.err);
    return r.out.trim();
  };
  assert.equal(m("jsonencode(1+2i)"), "MATLAB:jsonencode:UnsupportedComplex|jsonencode does not support complex numbers.");
  assert.equal(m("jsonencode(sparse(1))"), "MATLAB:jsonencode:UnsupportedSparse|jsonencode does not support sparse arrays.");
  assert.equal(m("jsonencode(1, 'Bogus', true)"), "MATLAB:jsonencode:InvalidParameter|'Bogus' is not a recognized parameter. For a list of valid name-value pair arguments, see the documentation for this function.");
  assert.equal(m("jsondecode('{\"a\": }')"), "MATLAB:jsondecode:ParseError|jsondecode: the text is not valid JSON (line 1, column 7): Expecting value.");
  assert.equal(m("jsondecode(5)"), "MATLAB:jsondecode:InvalidInput|The input must be a character vector or string scalar containing JSON text.");
  assert.equal(m("jsondecode([repmat('[', 1, 600) repmat(']', 1, 600)])"), "MATLAB:jsondecode:TooDeep|jsondecode: the JSON text is nested more than 512 levels deep.");
  // (brackets inside strings are not nesting)
  assert.equal(m("x = jsondecode(['\"' repmat('[', 1, 600) '\"']); disp(numel(x))"), "600\nPASS");
  assert.equal(m("jsondecode(['[' repmat('1,', 1, 50) '1]'])", { SAGEBRUSH_JSON_MAX_CHARS: "100" }),
    "MATLAB:jsondecode:TooLarge|jsondecode: the JSON text is 103 characters, over the limit of 100.");
  // (the values a text may hold, which bounds what parsing builds: 262,144; refused before it is parsed)
  assert.equal(m("v = jsondecode(['[' repmat('0,', 1, 262142) '0]']); disp(numel(v))"), "262143\nPASS");
  assert.equal(m("jsondecode(['[' repmat('0,', 1, 262144) '0]'])"), "MATLAB:jsondecode:TooLarge|jsondecode: the JSON text holds more than 262144 values.");
  // (a number of at most 1,000 digits, read as a double, as MATLAB reads integers: never as an arbitrary-precision one)
  assert.equal(m("disp(jsondecode(['[1' repmat('0', 1, 999) ']']))"), "Inf\nPASS");
  assert.equal(m("jsondecode(['[1' repmat('0', 1, 1000) ']'])"), "MATLAB:jsondecode:TooLarge|jsondecode: a number in the JSON text has more than 1000 digits.");
  assert.equal(m("jsondecode(['[1' repmat('0', 1, 199999) ']'])"), "MATLAB:jsondecode:TooLarge|jsondecode: a number in the JSON text has more than 1000 digits.");
  assert.equal(m("x = jsondecode('12345678901234567890123'); fprintf('%s %.17g\\n', class(x), x)"), "double 1.2345678901234568e+22\nPASS");
});

test("jsondecode's character bound can be lowered for a test, never raised", () => {
  const max = (env: Record<string, string>) => {
    const r = spawnSync(process.execPath, [cli, "-c", "import _matlab_json as j; print(j.MAX_CHARS)"], { encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  assert.equal(max({}), "4194304");
  assert.equal(max({ SAGEBRUSH_JSON_MAX_CHARS: "100" }), "100");
  assert.equal(max({ SAGEBRUSH_JSON_MAX_CHARS: "100000000" }), "4194304");
  assert.equal(max({ SAGEBRUSH_JSON_MAX_CHARS: "-5" }), "1");
});

test("a fitted result exported with jsonencode reads back as JSON (an agent's task: fminsearch, then ode45 as a check)", () => {
  const r = run([
    "t = linspace(0, 12, 121)';",
    "y = 1.7 .* exp(-0.18 .* t) .* cos(2.3 .* t + 0.4) + 0.001 .* sin(7 .* t);",
    "model = @(p) p(1) .* exp(-p(2) .* t) .* cos(p(3) .* t + p(4));",
    "loss = @(p) sum((model(p) - y).^2);",
    "[p, fval, exitflag] = fminsearch(loss, [1.5, 0.15, 2.2, 0.3], optimset('MaxIter', 2000, 'TolX', 1e-9, 'TolFun', 1e-12));",
    "a = p(2); w = p(3);",
    "rhs = @(s, z) [z(2); -2*a*z(2) - (a*a+w*w)*z(1)];",
    "z0 = [p(1)*cos(p(4)); -p(1)*a*cos(p(4))-p(1)*w*sin(p(4))];",
    "[tode, z] = ode45(rhs, t, z0, odeset('RelTol', 1e-8, 'AbsTol', 1e-10));",
    "result = struct('parameters', p, 'sse', fval, 'exitflag', exitflag, 'ode_error', max(abs(z(:,1) - model(p))), 'samples', length(t));",
    "disp(jsonencode(result));",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  const got = JSON.parse(r.out);
  assert.deepEqual(Object.keys(got), ["parameters", "sse", "exitflag", "ode_error", "samples"]);
  assert.equal(got.parameters.length, 4);
  for (const [k, want] of [[0, 1.7], [1, 0.18], [2, 2.3], [3, 0.4]] as const) assert.ok(Math.abs(got.parameters[k] - want) < 0.01, `${got.parameters}`);
  assert.equal(got.exitflag, 1);
  assert.equal(got.samples, 121);
  assert.ok(got.ode_error < 1e-5);
});
