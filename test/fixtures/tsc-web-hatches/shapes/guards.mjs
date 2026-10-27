// @ts-check
// False-positive guards: ordinary code with no hatch-like text anywhere: regexes after control heads and operators,
// escaped slashes, divisions, a URL in a string (a harmless "//" candidate), nested templates.
const s = "a/b";
if (s) /a\/b/.test(s);
while (!s) /x+/.exec(s);
export const r1 = /[a-z]+/g.test(s);
export const r2 = s.replace(/\//g, "-");
export const r3 = [/\*x/, /y\/\*/];
export const u = "https://example.test/path";
export const t = `x${`y${"z"}`}w`;
export const d = 6 / 2 / 3;
