import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// MATLAB's besselj (lib/_matlab_special.py over lib/_special.py): what
// matlab-tests/test_special.m cannot compare with Octave (negative Z, where
// Octave's values carry rounding noise in the other part) and the cases
// Sagebrush refuses.

const matlab = (code: string) =>
  execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--matlab", "-c", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("besselj: negative Z above the cut, the scale argument, sizes, classes and its refusals", () => {
  const out = matlab([
    "a = besselj(0.5, -2); fprintf('%.15g %.15g\\n', real(a), imag(a));",
    "b = besselj(2, -3); fprintf('%d %.15g\\n', isreal(b), b);",
    "c = besselj(1.5, [-1 1]); fprintf('%.15g ', real(c), imag(c)); fprintf('\\n');",
    "fprintf('%.15g\\n', besselj(-3, 4)); fprintf('%.15g\\n', besselj(1, 2, 1) - besselj(1, 2));",
    "disp(size(besselj([0 1 2], [1 2 3]))); disp(size(besselj(0:3, 2))); disp(class(besselj(single(1), 2)));",
    "fprintf('%g\\n', besselj(0, Inf));",
    "try, besselj(-0.5, 1), catch e, disp(e.message), end",
    "try, besselj(1, 1+2i), catch e, disp(e.message), end",
    "try, besselj(1, 2, 3), catch e, disp(e.message), end",
    "try, besselj([0; 1], [1 2]), catch e, disp(e.message), end",
    "try, besselj(1+1i, 2), catch e, disp(e.message), end",
  ].join("\n") + "\n");
  assert.deepEqual(out.split("\n").map((l: string) => l.trim()).filter(Boolean), [
    // (J_(1/2)(-2) = e^(i pi/2) J_(1/2)(2): purely imaginary; J_2(-3) = J_2(3), real)
    "0 0.513016136561828",
    "1 0.486091260585891",
    "0 0.240297839123427 -0.240297839123427 0",
    "-0.430171473875622",
    "0",
    "1     3", "1     4", "single",
    "NaN",
    "besselj: Sagebrush covers negative orders only when they are integers.",
    "besselj: Sagebrush does not compute besselj of complex Z yet.",
    "besselj: scale must be 0 or 1.",
    "besselj: nu and Z must be the same size, or one of them a scalar.",
    "besselj: nu must be real.",
  ]);
});
