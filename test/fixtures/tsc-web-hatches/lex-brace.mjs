// @ts-check
// The one ambiguous context, a slash after } (astra2 #232 r3 T1-LEX): tsc accepts this line (the arithmetic error is
// expected), and the policy must fail closed, since a regex read would swallow the real JSDoc inside the brackets.
// @ts-expect-error an object literal divided, kept to exercise the lexer's } context
export const z = {} / [/** @type {any} */ (1)] / 2;
