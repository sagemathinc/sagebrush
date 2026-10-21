// The "early alpha" notice on sagebrush.space's own pages (SECURITY.md): one
// line, fixed at the foot of the window, so it moves nothing on the page.  It
// is put only in the site's pages (web/build.ts, web/atlas/render.ts,
// web/build-articles.ts), never in the board template that downloaded boards
// and the frame other sites embed (/frame/board/, CoCalc's chat cards) are
// made from, nor in the runner or the notebook component.  And it never
// shows in a frame, whatever page it is in: a page another site embeds keeps
// its own look.  Dismissed, it stays away in this browser.
(() => {
  const KEY = "sagebrush-alpha-banner-dismissed";
  try {
    if (window.top !== window) return;
  } catch {
    return; // (a cross-origin parent: framed)
  }
  try {
    if (localStorage.getItem(KEY)) return;
  } catch {
    // (no storage: shown, and dismissed for this page only)
  }
  const show = () => {
    if (document.getElementById("sb-alpha-banner")) return;
    const bar = document.createElement("div");
    bar.id = "sb-alpha-banner";
    bar.setAttribute("role", "note");
    bar.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;gap:.6em;" +
      "padding:3px 2.4em 3px .8em;background:#fff4d6;color:#4a3b10;border-top:1px solid #e8d49a;font:12px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;" +
      "text-align:center;box-sizing:border-box";
    const text = document.createElement("span");
    text.textContent = "Early alpha, pre-launch: Sagebrush is not yet security-hardened. Don't store anything sensitive here.";
    const more = document.createElement("a");
    more.href = "https://github.com/sagemathinc/sagebrush/blob/master/SECURITY.md";
    more.textContent = "Security";
    more.rel = "noopener";
    more.target = "_blank";
    more.style.cssText = "color:inherit;text-decoration:underline";
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss this notice");
    close.textContent = "×";
    close.style.cssText =
      "position:absolute;right:.4em;top:50%;transform:translateY(-50%);border:0;background:none;color:inherit;font:16px/1 system-ui,sans-serif;cursor:pointer;padding:2px 6px";
    close.addEventListener("click", () => {
      bar.remove();
      try {
        localStorage.setItem(KEY, "1");
      } catch {
        // (no storage: gone for this page only)
      }
    });
    bar.append(text, more, close);
    document.body.append(bar);
  };
  if (document.body) show();
  else document.addEventListener("DOMContentLoaded", show, { once: true });
})();
