// The Files | Agents switch at the right of the side panel's header (William, Nov 12: "REPLACE the "x" in the upper
// right of the panel with a mode switch, similar to what claude.ai does, but the two modes for sagebrush are "Files"
// and "Agents""): two icons, the mode shown pressed. Files is the notebook page with its files (/), Agents the agents
// page (/agents/); choosing the other mode opens its page. The file panel and the agents page each make one.

const SVG = "http://www.w3.org/2000/svg";
function svg(parts: [string, Record<string, string>][]): SVGSVGElement {
  const s = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false", fill: "none", stroke: "currentColor", "stroke-width": "1.3", "stroke-linejoin": "round", "stroke-linecap": "round" })) s.setAttribute(k, v);
  for (const [tag, attrs] of parts) {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    s.append(e);
  }
  return s;
}
/** A folder. */
const filesIcon = () => svg([["path", { d: "M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.6H13c.7 0 1.2.5 1.2 1.2v6.4c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" }]]);
/** A speech bubble with a spark: a chat with an agent. */
const agentsIcon = () => svg([["path", { d: "M2.2 4.5c0-1 .8-1.8 1.8-1.8h8c1 0 1.8.8 1.8 1.8v4.6c0 1-.8 1.8-1.8 1.8H7.2L4.4 13.3v-2.4H4c-1 0-1.8-.8-1.8-1.8z" }],
  ["path", { d: "M8 4.6v3M6.5 6.1h3" }]]);

export const MODE_SWITCH_CSS = `
.sb-mode { display: inline-flex; flex: none; gap: 2px; padding: 2px; border-radius: 8px; background: #e9e8e1; }
.sb-mode button { display: grid; place-items: center; width: 28px; height: 24px; padding: 0; border: 0; border-radius: 6px; background: none; color: #5d645f; cursor: pointer; }
.sb-mode button:hover { color: #1f2421; }
.sb-mode button[aria-pressed="true"] { background: #fff; color: #1f2421; box-shadow: 0 1px 2px rgba(0, 0, 0, .14); cursor: default; }
.sb-mode button:focus-visible { outline: 2px solid #4a6b49; outline-offset: 1px; }
.sb-mode svg { width: 16px; height: 16px; }
:root[data-theme="dark"] .sb-mode { background: #2a302b; }
:root[data-theme="dark"] .sb-mode button { color: #a3aba4; }
:root[data-theme="dark"] .sb-mode button:hover, :root[data-theme="dark"] .sb-mode button[aria-pressed="true"] { color: #f4f6f1; }
:root[data-theme="dark"] .sb-mode button[aria-pressed="true"] { background: #3d463e; box-shadow: none; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .sb-mode { background: #2a302b; }
  :root:not([data-theme="light"]) .sb-mode button { color: #a3aba4; }
  :root:not([data-theme="light"]) .sb-mode button:hover, :root:not([data-theme="light"]) .sb-mode button[aria-pressed="true"] { color: #f4f6f1; }
  :root:not([data-theme="light"]) .sb-mode button[aria-pressed="true"] { background: #3d463e; box-shadow: none; }
}
`;

export type Mode = "files" | "agents";
const MODES: { mode: Mode; label: string; href: string; icon: () => SVGSVGElement }[] = [
  { mode: "files", label: "Files", href: "/", icon: filesIcon },
  { mode: "agents", label: "Agents", href: "/agents/", icon: agentsIcon },
];

/** The switch, `current` pressed; the other mode's button opens its page. */
export function modeSwitch(current: Mode): HTMLElement {
  if (!document.getElementById("sb-mode-css")) {
    const st = document.createElement("style");
    st.id = "sb-mode-css";
    st.textContent = MODE_SWITCH_CSS;
    document.head.append(st);
  }
  const box = document.createElement("div");
  box.className = "sb-mode";
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "Mode");
  for (const m of MODES) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.mode = m.mode;
    b.title = m.label;
    b.setAttribute("aria-label", m.label);
    b.setAttribute("aria-pressed", String(m.mode === current));
    b.append(m.icon());
    if (m.mode !== current) b.onclick = () => location.assign(m.href);
    box.append(b);
  }
  return box;
}
