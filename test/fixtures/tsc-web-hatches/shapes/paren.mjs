// @ts-check
// astra2 T1-LEX: a division after a parenthesised operand (tsc accepts it; the policy must refuse the any or fail closed)
const a = 1, b = 2;
export const q = (a) / b; /** @type {any} */ export const x = JSON.parse("1");
