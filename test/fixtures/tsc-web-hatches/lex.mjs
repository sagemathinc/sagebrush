// @ts-check
// The lexer's slash context (astra2 #232 r2 T1-LEX), every line accepted by tsc: a division after a postfix ++, a
// postfix -- and a parenthesised operand, each followed by a comment the policy must see and refuse; and the false-
// positive guards, a regex after a control head holding comment-like text, and nested template expressions.
let a = 1;
const b = 2;
export const q1 = a++ / b; /** @type {{
 *   v: any
 * }} */ export const w1 = { v: JSON.parse("1") };
export const q2 = a-- / b; // @ts-ignore
export const q3 = (a) / b; /** @type {any} */ export const w3 = JSON.parse("2");
if (a) /a\/*b/.test("a/b");
export const n = `x${`y${"/* @ts-nocheck */"}`}z`;
