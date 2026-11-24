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
  /** after every change of the text the person makes (not one set by the page) */
  changed?(value: string): void;
}

// (whether the thread shown has a turn running, as last rendered: then the primary action steers it where its agent
//  takes steers, and queues otherwise; it never interrupts)
let running = false;
let steer = false;

/** The editor in #editor (Shift+Enter sends, or while a turn runs steers it (queues where the agent can't be steered);
 *  Alt+Enter queues; Ctrl/Cmd+Enter adds a note) and the buttons' wiring. Only Send now and Stop interrupt the agent. */
export function mountComposer(h: ComposerHooks): BlockEditor {
  const primary = () => h.submit(running ? (steer ? "steer" : "queued") : "sent");
  const editor = new BlockEditor("", {
    render: h.render,
    typeset: h.typeset,
    placeholder: "Message Claude…",
    onChange: (v) => { keysShown(v); h.changed?.(v); },
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
  // (beside Steer, the second button queues; beside Queue, it is Send now, which interrupts)
  $("#send-now").onclick = () => h.submit(steer ? "queued" : "sent");
  $("#note").onclick = () => h.submit("note");
  $("#stop").onclick = () => h.stop();
  return editor;
}

/** The keys under the prompt, only while it has something to send (as a chat's hint shows only once you type, #1806):
 *  an empty prompt shows none. Hidden, not removed, so the buttons beside them stay put. After every change of the text,
 *  the person's (the editor's onChange) and the page's own (page.ts, where it sets the text). */
export function keysShown(value: string) {
  $(".composer .hint")?.classList.toggle("idle", !value.trim());
}

/** The buttons for the thread shown: Send; while a turn runs, Steer with Queue and Stop beside it where the agent takes
 *  steers (`canSteer`), else Queue with Send now and Stop; and how many are queued. `away`: the chat's last turn lost
 *  its agent's connection, and a message waits for that turn's end: the primary action queues, with no one to
 *  interrupt or stop (no Send now, no Stop). */
export function renderComposerState(busy: boolean, queued: number, away = false, canSteer = false) {
  running = busy || away;
  steer = busy && canSteer;
  $("#send").textContent = steer ? "Steer" : busy || away ? "Queue" : "Send";
  $("#send").title = steer ? "Send to the running turn: Claude reads it at its next step (Shift+Enter)" : busy ? "Send after the current turn (Shift+Enter)" : away ? "Send once the agent says how its last turn went (Shift+Enter)" : "Send (Shift+Enter)";
  $("#send-now").hidden = !busy;
  $("#send-now").textContent = steer ? "Queue" : "Send now";
  $("#send-now").title = steer ? "Send after the current turn (Alt+Enter)" : "Interrupt the agent and send this now";
  $("#stop").hidden = !busy;
  $("#keys").textContent = steer ? "steer" : busy || away ? "queue" : "send";
  $("#queued").textContent = queued ? `${queued} queued` : "";
}

/** The chat's Stop, named after the agent (the notebook has a Stop of its own). */
export const stopLabel = (agent: string) => `Stop ${agent}`;
