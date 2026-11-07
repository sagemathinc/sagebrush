// When the code page (page.ts) lets a file be edited: only if it can be written back exactly (latex/save.ts openBytes'
// saveable), is at most EDIT_BYTES, and is here (a remote entry is in the cloud: its bytes are another device's).
// One rule, for the page as it opens and as it follows a change made elsewhere; tested in test-code-tokens.mjs.
export const EDIT_BYTES = 2 ** 20;
export const editableOf = (saveable: boolean, bytes: number, remote: boolean | undefined): boolean => saveable && bytes <= EDIT_BYTES && !remote;
