// The agents page's composer (web/agents): the message editor with its keys, the Send (Queue while a turn runs), Send
// now, Note and Stop buttons, and their labels. What sending does (the queues, interrupting a turn) stays in page.ts, passed in as hooks.
import { BlockEditor } from "../../board/blocks";
import type { UserEntry } from "./events";

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

export interface ComposerHooks {
  submit(mode: UserEntry["mode"]): void;
  stop(): void;
  render(src: string): string;
  typeset(el: Element): void;
}

// (whether the thread shown has a turn running, as last rendered: then the primary action queues, never interrupts)
let running = false;

/** The editor in #editor (Shift+Enter sends, or queues while a turn runs; Alt+Enter queues; Ctrl/Cmd+Enter adds a
 *  note) and the buttons' wiring. Only Send now and Stop interrupt the agent. */
export function mountComposer(h: ComposerHooks): BlockEditor {
  const primary = () => h.submit(running ? "queued" : "sent");
  const editor = new BlockEditor("", {
    render: h.render,
    typeset: h.typeset,
    placeholder: "Message Claude…  (Shift+Enter to send)",
    onKey(e) {
      if (e.key !== "Enter") return false;
      if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) return (e.preventDefault(), primary(), true);
      if (e.altKey) return (e.preventDefault(), h.submit("queued"), true);
      if (e.ctrlKey || e.metaKey) return (e.preventDefault(), h.submit("note"), true);
      return false;
    },
  });
  $("#editor").append(editor.el);
  $("#send").onclick = primary;
  $("#send-now").onclick = () => h.submit("sent");
  $("#note").onclick = () => h.submit("note");
  $("#stop").onclick = () => h.stop();
  return editor;
}

/** The buttons for the thread shown: Send, or while a turn runs Queue with Send now and Stop beside it; and how many
 *  are queued. `away`: the chat's last turn lost its agent's connection, and a message waits for that turn's end: the
 *  primary action queues, with no one to interrupt or stop (no Send now, no Stop). */
export function renderComposerState(busy: boolean, queued: number, away = false) {
  running = busy || away;
  $("#send").textContent = busy || away ? "Queue" : "Send";
  $("#send").title = busy ? "Send after the current turn (Shift+Enter)" : away ? "Send once the agent says how its last turn went (Shift+Enter)" : "Send (Shift+Enter)";
  $("#send-now").hidden = !busy;
  $("#stop").hidden = !busy;
  $("#keys").textContent = busy || away ? "queue" : "send";
  $("#queued").textContent = queued ? `${queued} queued` : "";
}

/** The chat's Stop, named after the agent (the notebook has a Stop of its own). */
export const stopLabel = (agent: string) => `Stop ${agent}`;
