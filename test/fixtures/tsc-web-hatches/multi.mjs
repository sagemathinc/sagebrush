// @ts-check
/**
 * An unexplained any, its type over three lines (tsc accepts it; the policy must not).
 * @type {{
 *   x: any
 * }}
 */
export const unexplained = { x: JSON.parse("1") };

/**
 * A reasoned one, also over lines.  any: a parsed JSON payload, validated by the caller
 * @type {Array<
 *   *
 * >}
 */
export const reasoned = JSON.parse("[]");

/** @type {number} */
// @ts-expect-error a planted mismatch, kept so the directive is exercised and counted
export const planted = "not a number";

// (not comments: a string, a template with an expression, and a regex that hold comment-like text)
export const s = "/* @ts-ignore */ // @ts-nocheck";
export const t = `${"// @ts-ignore"} /* @ts-nocheck */`;
export const r = /\/* @ts-ignore/;
