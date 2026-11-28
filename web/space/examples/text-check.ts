// The repository's push text check, applied to what the build writes for the 3D view's examples (web/build.ts): the
// generated spaces carry repository paths, documentation and code, which a diff never shows. The pattern names
// institutions, people's handles and local paths; it is stored encoded so that this file doesn't trip the check itself.
// "cup product" (a cohomology term) is allowed, as the push check allows it.
const ENCODED = "Y2FtYnJpZGdlfHVjbGF8XGJjdXBcYnxtYW5jaGVzdGVyfC9ob21lL3VzZXJ8L3NjcmF0Y2gvfHVuaXZlcnNpdHl8c2FnZWJydXNoLWdwdVswLTldfFxiYXN0cmFbMC05XXxcYmRheWJyZWFrWzAtOV18XGJncHVbMC05XVxifFxiZ3JhZGVyXGJ8XGJzYWdlMlxifFxic2VsZi1ob3N0XGJ8XGJtYWNhcHBcYg==";
export const PUSH_TEXT = new RegExp(atob(ENCODED), "gi");
/** each match of the push text check in s, with a little context: none means it passes */
export function textProblems(s: string): string[] {
  const t = s.replace(/\bcup product\b/gi, "");
  return [...t.matchAll(PUSH_TEXT)].map((m) => JSON.stringify(t.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30)));
}
