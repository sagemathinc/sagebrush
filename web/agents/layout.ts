// The agents page's layout (web/agents): the body classes that place the chat, the artifact pane and full screen.
import type { Artifact } from "./events";

/** The pane-state classes on body: an artifact shown, full screen, and a notebook (a wider pane). */
export function applyPaneClasses(a: Artifact | undefined, fullscreen: boolean) {
  document.body.classList.toggle("has-artifact", !!a);
  document.body.classList.toggle("fullscreen", !!a && fullscreen);
  document.body.classList.toggle("wide-artifact", !!a && a.kind === "notebook");
}
