// @ts-check
// False-positive guards: ordinary regexes (no comment-like text in their spans), after control heads, after
// operators and in templates; nested template expressions holding comment-like text; none of it is a hatch.
const s = "a/b";
if (s) /a\/b/.test(s);
while (!s) /x+/.exec(s);
export const r1 = /[a-z]+/g.test(s);
export const r2 = s.replace(/\//g, "-");
export const r3 = [/\*x/, /y\/\*/];
export const t = `x${`y${"/* @ts-nocheck */"}`}z`;
export const d = 6 / 2 / 3;
