// Connect an agent's first screen, opened by hand: the instruction for the person's own coding agent
// (agent-instruction.ts), a read-only box sized to it, and Copy, its one primary action. A chunk of its own,
// /sagebrush-agent-instruction.js, fetched only when the person opens Connect by hand (agent-ui.ts), never for a
// pairing link, a code or the Agents page's own program; with its styling, so the pairing chunk every page carries
// doesn't grow by it.

import { agentInstruction } from "./agent-instruction";

const CSS = `
.sbag-box.wide { width: min(660px, 92vw); }
.sbag-box textarea.instr { font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; color: #1d241a; background: #f6f7f3; border: 1px solid #e6e9e1; border-radius: 6px; padding: 8px 10px; resize: vertical; white-space: pre-wrap; field-sizing: content; max-height: 50vh; }
.sbag-box .row .grow { flex: 1; }
.sbag-box button.link { border: 0; background: none; padding: 5px 0; color: #3f6b35; text-decoration: underline; }
`;
let styled = false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

/** Fills `box` (the dialog's box, its title kept) with the screen, unless the dialog closed meanwhile. `close` closes
 * the dialog; `byCode` shows the same dialog's code and port. */
export function instructionScreen(box: HTMLElement, close: () => void, byCode: () => void) {
  if (!box.isConnected) return;
  if (!styled) { styled = true; document.head.append(h("style", { textContent: CSS })); }
  const text = agentInstruction(location.origin);
  const area = h("textarea", { className: "instr", readOnly: true, value: text, rows: 9, spellcheck: false });
  area.setAttribute("aria-label", "The instruction for your agent");
  const said = h("div", { className: "note", role: "status" });
  const copy = h("button", { className: "primary", textContent: "Copy" });
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "Copied";
      said.textContent = "";
    } catch {
      area.focus();
      area.select();
      said.textContent = "Couldn't copy: the text is selected, so press Ctrl+C (⌘C on a Mac).";
    }
  };
  const cancel = h("button", { textContent: "Cancel" });
  cancel.onclick = close;
  const code = h("button", { className: "link", textContent: "Have a code?" });
  code.title = "Enter the code and port an agent gave you";
  code.onclick = () => { box.classList.remove("wide"); box.replaceChildren(box.firstChild!); byCode(); };
  // (the connect page's sagebrush-mcp section, in a new tab, as the dialog's other Learn more)
  const learn = h("a", { href: "/agents/connect/#mcp", target: "_blank", rel: "noopener", textContent: "Learn more" });
  box.classList.add("wide");
  box.append(h("div", {}, "Paste this into Claude Code, Codex or another agent that supports MCP. The agent gives you a link: open it to choose what the agent may use. ", learn),
    area, said, h("div", { className: "row" }, code, h("span", { className: "grow" }), cancel, copy));
  setTimeout(() => copy.focus());
}
