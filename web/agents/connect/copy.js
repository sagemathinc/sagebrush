// The connect page's Copy buttons (web/agents/connect/index.html): each copies the command beside it. A file of its
// own, so the page needs no inline script (the site's policy for /agents/* is script-src 'self'). Without it the buttons
// stay hidden and a click on a command selects it whole (user-select: all).
for (const b of document.querySelectorAll("button.copy")) {
  const pre = b.parentElement?.querySelector("pre");
  if (!pre || !navigator.clipboard) continue;
  b.hidden = false;
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent.trim());
      b.textContent = "Copied";
    } catch {
      b.textContent = "Select it, then copy";
    }
    setTimeout(() => (b.textContent = "Copy"), 2000);
  });
}
