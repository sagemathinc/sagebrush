// Text for a terminal that anyone may have written (a file's name, what a
// board or its code says): its control characters shown, escaped as \xHH,
// never obeyed (design/security.md).
const escape = (c: string) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;

/** One line of a diagnostic: every C0 and C1 control escaped, newlines and
 * tabs among them, so none starts a line of its own (HARD-EC2-1). */
export const oneLine = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, escape);

/** Lines of text (what a cell printed): the same, but for newlines and tabs. */
export const textLines = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, escape);
