// A beamer slide at one of its overlay steps (render.mjs marks them: an element with class ov has data-ov, the steps
// it is for ("2-", "1,3-4", "-3"), and data-ovm, how it shows on the others: only (no room), uncover (its room kept),
// invisible (hidden on its steps), onlynot (shown on the others); span.ovpause[data-pause=k], a \pause, after which
// the frame's content is shown from step k + 1 on). Used by the presenter (present.ts), the agent tools' pictures
// (tools.ts) and `sagebrush latex render --steps`, which sends this function's source to its browser: it is
// self-contained (no names from outside it).

/** Show `slide` (a section.slide, or a copy of one) as it is at overlay step `step` (1-based); again with another step
 * undoes the last one first. */
export function applyStep(slide: Element, step: number): void {
  const inSpec = (spec: string) => spec.split(",").some((p) => {
    const m = /^(\d*)(-?)(\d*)$/.exec(p);
    if (!m || (!m[1] && !m[3])) return false;
    const a = m[1] ? +m[1] : 1, z = m[2] ? (m[3] ? +m[3] : Infinity) : a;
    return step >= a && step <= z;
  });
  // (the last step's changes undone: text wrapped for a \pause unwrapped, styles set here cleared)
  for (const w of Array.from(slide.querySelectorAll("span.ovwrap"))) w.replaceWith(...Array.from(w.childNodes));
  for (const el of Array.from(slide.querySelectorAll("[data-ovstate]")) as HTMLElement[]) { el.style.display = ""; el.style.visibility = ""; el.removeAttribute("data-ovstate"); }
  for (const el of Array.from(slide.querySelectorAll(".ov[data-ov]")) as HTMLElement[]) {
    const on = inSpec(el.getAttribute("data-ov") || ""), m = el.getAttribute("data-ovm");
    const hide = m === "only" || m === "uncover" ? !on : on;
    if (!hide) continue;
    el.setAttribute("data-ovstate", "1");
    if (m === "only" || m === "onlynot") el.style.display = "none"; else el.style.visibility = "hidden";
  }
  // a \pause not reached yet: everything after it in the frame is hidden, its room kept
  const mark = Array.from(slide.querySelectorAll("span.ovpause")).find((m) => +(m.getAttribute("data-pause") || 0) >= step);
  if (!mark) return;
  const body = slide.querySelector(".slide-body") || slide;
  const hideAfter = (node: Node) => {
    for (const c of Array.from(node.childNodes)) {
      if (c === mark) continue;
      if (c.contains(mark)) { hideAfter(c); continue; }
      if (!(mark.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if (c.nodeType === 1) { (c as HTMLElement).setAttribute("data-ovstate", "1"); (c as HTMLElement).style.visibility = "hidden"; }
      else if (c.nodeType === 3 && (c.textContent || "").trim()) {
        const w = document.createElement("span"); w.className = "ovwrap"; w.setAttribute("data-ovstate", "1"); w.style.visibility = "hidden";
        c.replaceWith(w); w.appendChild(c);
      }
    }
  };
  hideAfter(body);
}

/** A slide's overlay steps (render.mjs's data-steps), at least 1. */
export const stepsOf = (slide: Element) => Math.max(1, +(slide.getAttribute("data-steps") || 1) || 1);
