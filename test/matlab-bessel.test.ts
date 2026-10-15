import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// MATLAB's besselj and bessely (lib/_matlab_special.py over lib/_special.py): what
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
    "try, besselj(-130.90617429837465, 129.18409377916606), catch e, disp(e.message), end",
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
    "besselj: the connection formula for order -130.90617429837465 cancels at x = 129.18409377916606.",
    "besselj: Sagebrush does not compute besselj of complex Z yet.",
    "besselj: scale must be 0 or 1.",
    "besselj: nu and Z must be the same size, or one of them a scalar.",
    "besselj: nu must be real.",
  ]);
});

test("bessely: negative Z above the cut, zero, negative orders, the scale argument, sizes, classes and its refusals", () => {
  const out = matlab([
    "a = bessely(0.5, -2); fprintf('%.15g %.15g\\n', real(a), imag(a));",
    "b = bessely(2, -3); fprintf('%d %.15g %.15g\\n', isreal(b), real(b), imag(b));",
    "fprintf('%g ', bessely([0 1 -1 -2 -0.5 -0.3 -0.7], 0)); fprintf('\\n');",
    "fprintf('%.15g\\n', bessely(-0.5, 2)); fprintf('%.15g\\n', besselj(-0.5, 2)); fprintf('%.15g\\n', bessely(1, 2, 1) - bessely(1, 2));",
    "fprintf('%g %g %.15g\\n', bessely(1000, 1), bessely(-1000.5, 1), bessely(171, 2));",
    "disp(size(bessely([0 1 2], [1 2 3]))); disp(size(bessely(0:3, 2))); disp(class(bessely(single(1), 2)));",
    "fprintf('%g\\n', bessely(0, Inf));",
    "z = bessely(171.50000000000003, -1.8); fprintf('%.17g %.17g\\n', real(z), imag(z));",
    "try, bessely(-46.384401075334324, 45.581111665644976), catch e, disp(e.message), end",
    "try, bessely(1, 1+2i), catch e, disp(e.message), end",
    "try, bessely(1, 2, 3), catch e, disp(e.message), end",
    "try, bessely([0; 1], [1 2]), catch e, disp(e.message), end",
    "try, bessely(1+1i, 2), catch e, disp(e.message), end",
    "try, bessely(1, int8(2)), catch e, disp(e.message), end",
  ].join("\n") + "\n");
  assert.deepEqual(out.split("\n").map((l: string) => l.trim()).filter(Boolean), [
    // (Y_(1/2)(-2) = e^(-i pi/2) Y_(1/2)(2), purely imaginary (Octave's real part is about -7e-16); Y_2(-3) = Y_2(3) + 2i J_2(3))
    "0 -0.234785710406248",
    "0 -0.160400393484924 0.972182521171782",
    // (Octave's values at 0: the parity sign at negative integers, 0 at negative half-integers, -sign(cos(nu pi)) otherwise)
    "-Inf -Inf Inf -Inf 0 -Inf Inf",
    "0.513016136561828", "-0.234785710406248", "0",
    // (Y_1000(1) is about -1.4e2865 and Y_(-1000.5)(1) about 5.2e-2871; Octave gives Inf+Infi for the first and for Y_171(2))
    "-Inf 0 -2.32373628765076e+306",
    "1     3", "1     4", "single",
    "NaN",
    // (daybreak's CORR-F00-1: the real part cos(nu pi) Y_nu(1.8) is a double, -1.9058365700442774e302 at 100 digits)
    "-1.9058365700442768e+302 -Inf",
    "bessely: the connection formula for order -46.384401075334324 cancels at x = 45.581111665644976.",
    "bessely: Sagebrush does not compute bessely of complex Z yet.",
    "bessely: scale must be 0 or 1.",
    "bessely: nu and Z must be the same size, or one of them a scalar.",
    "bessely: nu must be real.",
    "Undefined function 'bessely' for input arguments of type 'int8'.",
  ]);
});
