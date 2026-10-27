// @ts-check
// astra2 T1-LEX r5: the backtick variant: a REAL regex holding a backtick, which a lexer reading it as a division would
// take for a template.  tsc accepts it; the policy must refuse the any.
export function h() {
  debugger
  /`/; /** @type {any} */ const z = JSON.parse("1"); /`/;
  return z;
}
