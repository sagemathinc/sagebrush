// "PDF for Gradescope": what the student's and the instructor's dialogs share: their style (put in the page once,
// by whichever dialog opens first) and two small helpers.

const DIALOG_CSS = `
dialog.gs-dlg { width: min(640px, 94vw); max-height: 90vh; padding: 0; border: 1px solid #8884; border-radius: 10px; color: inherit; background: Canvas; }
dialog.gs-dlg::backdrop { background: #0006; }
.gs-dlg form { display: flex; flex-direction: column; gap: 12px; padding: 16px 18px; }
.gs-dlg h2 { margin: 0; font-size: 1.15rem; }
.gs-dlg .sub { margin: 0; opacity: .8; font-size: .92rem; }
.gs-dlg label { display: grid; grid-template-columns: 8.5em 1fr; align-items: center; gap: 8px; }
.gs-dlg input[type=text] { font: inherit; padding: 4px 6px; }
.gs-dlg table { border-collapse: collapse; width: 100%; font-size: .93rem; }
.gs-dlg td, .gs-dlg th { text-align: left; padding: 3px 6px; border-bottom: 1px solid #8883; }
.gs-dlg td.ok { color: #15803d; } .gs-dlg td.bad { color: #b42318; font-weight: 600; }
.gs-dlg ul { margin: 0; padding-left: 1.2em; } .gs-dlg li { margin: 3px 0; }
.gs-dlg .over { border: 1.5px solid #b42318; border-radius: 6px; padding: 8px 10px; }
.gs-dlg .over .acts { justify-content: flex-start; margin: 8px 0 4px; }
.gs-dlg .note { font-size: .88rem; opacity: .85; margin: 0; }
.gs-dlg .acts { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.gs-dlg button { font: inherit; padding: 5px 12px; border-radius: 6px; cursor: pointer; }
.gs-dlg button.primary { font-weight: 600; }
.gs-dlg button.link { border: 0; background: none; padding: 0 2px; color: LinkText; text-decoration: underline; }
`;
let styled = false;
/** The dialogs' style, in the page once. */
export function dialogStyle(): void {
  if (styled) return;
  styled = true;
  document.head.append(Object.assign(document.createElement("style"), { textContent: DIALOG_CSS }));
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
}
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
