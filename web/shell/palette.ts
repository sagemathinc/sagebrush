// The Terminal's 16 colours (plan-bash-shell r8c E5.3), light and dark, each >= 4.5:1 on its theme's background
// (min 4.91 light, 6.15 dark): CSS variables on :root, which web/shell/panel.ts reads back as xterm's theme, so the
// screen follows the page's theme.  Kept apart from the panel so its contrast is tested directly
// (web/shell/test-panel-palette.mjs).
export const LIGHT = "1f2328 b3261e 116329 7a4a00 0550ae 8250df 0e6e74 59636e 424a53 c9271b 1a7f37 8a5300 0969da 9e45d6 0b7a80 59636e";
export const DARK = "c9d1d9 ff7b72 3fb950 d29922 58a6ff bc8cff 39c5cf b1bac4 8b949e ffa198 56d364 e3b341 79c0ff d2a8ff 56d4dd f0f6fc";
export function palette(): string {
  const vars = (p: string, fg: string, bg: string) => p.split(" ").map((c, i) => `--sb-term-c${i}:#${c}`).join(";") + `;--sb-term-fg:#${fg};--sb-term-bg:#${bg}`;
  const dark = vars(DARK, "e6edf3", "0d1117");
  return `:root{${vars(LIGHT, "1f2328", "ffffff")}}:root[data-theme=dark]{${dark}}@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${dark}}}`;
}
