// @ts-check
// astra2 T1-LEX: a division after } inside brackets (an expect-error for the arithmetic, reasoned) (tsc accepts it; the policy must refuse the any or fail closed)
// @ts-expect-error an object literal divided, kept to exercise the lexer
export const z = {} / [/** @type {any} */ (1)] / 2;
