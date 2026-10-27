// @ts-check
// The lexer's member-access context (astra2 #232 r3 T1-LEX): a keyword-like property name is an operand, so these
// slashes are divisions and the comments after them are seen (and refused); a real regex whose class holds / and *
// in a certain context is harmless.  tsc accepts every line.
const b = 2;
/** @type {any} */ const obj = { return: 6, if: (/** @type {number} */ v) => v }; // any: a test object
export const q = obj.return / b; /** @type {any} */ export const x = JSON.parse("1");
export const w = obj.if(1) / b; /** @type {any} */ export const y = JSON.parse("2");
export const re = /[/*]x/.test("/*x");
export const re2 = (/[*/]y\//).test("y/");
