// The agents page's composer (web/agents): the message editor with its keys, the Send, Queue, Note and Stop buttons,
// and their labels. What sending does (the queues, interrupting a turn) stays in page.ts, passed in as hooks.
import { BlockEditor } from "../board/blocks";
import type { UserEntry } from "./events";

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

export interface ComposerHooks {
  submit(mode: UserEntry["mode"]): void;
  stop(): void;
  render(src: string): string;
  typeset(el: Element): void;
}

/** The editor in #editor (Shift+Enter sends, Alt+Enter queues, Ctrl/Cmd+Enter adds a note) and the buttons' wiring. */
export function mountComposer(h: ComposerHooks): BlockEditor {
  const editor = new BlockEditor("", {
    render: h.render,
    typeset: h.typeset,
    placeholder: "Message Claude…  (Shift+Enter to send)",
    onKey(e) {
      if (e.key !== "Enter") return false;
      if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) return (e.preventDefault(), h.submit("sent"), true);
      if (e.altKey) return (e.preventDefault(), h.submit("queued"), true);
      if (e.ctrlKey || e.metaKey) return (e.preventDefault(), h.submit("note"), true);
      return false;
    },
  });
  $("#editor").append(editor.el);
  $("#send").onclick = () => h.submit("sent");
  $("#queue").onclick = () => h.submit("queued");
  $("#note").onclick = () => h.submit("note");
  $("#stop").onclick = () => h.stop();
  return editor;
}

/** The buttons for the thread shown: Send or Send now, Queue and Stop while a turn runs, and how many are queued. */
export function renderComposerState(running: boolean, queued: number) {
  $("#send").textContent = running ? "Send now" : "Send";
  $("#send").title = running ? "Interrupt the agent and send (Shift+Enter)" : "Send (Shift+Enter)";
  $("#queue").hidden = !running;
  $("#stop").hidden = !running;
  $("#queued").textContent = queued ? `${queued} queued` : "";
}

/** The chat's Stop, named after the agent (the notebook has a Stop of its own). */
export const stopLabel = (agent: string) => `Stop ${agent}`;
