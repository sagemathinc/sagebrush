// Serialized into the existing same-origin preview-config.js. No inline script,
// inline event handler, third-party asset, or change to a page's script hashes.
export function installPreviewNotice(config) {
  if (location.hostname !== config.host) return;
  const key = 'sagebrush-preview-notice-hidden';
  try { if (sessionStorage.getItem(key) === '1') return; } catch {}
  // (where the pill goes: inside the site's early-alpha notice while that shows, one line at the foot that moves nothing
  //  (William: the pill below it "seems really bad"); else docked in a gutter of its own at the foot, kept clear of the
  //  page's controls, as before)
  const DOCK_CSS = `
      :root { --sb-preview-gutter: calc(44px + env(safe-area-inset-bottom, 0px)); }
      body { padding-bottom: var(--sb-preview-gutter) !important; }
      #board, #wssidebar, .tex-page { bottom: calc(var(--sb-preview-gutter) + var(--sb-alpha-banner, 0px)) !important; }
      .sbfiles { max-height: calc(100dvh - var(--sb-preview-gutter) - var(--sb-alpha-banner, 0px)) !important; }
      #sb-alpha-banner { bottom: var(--sb-preview-gutter) !important; }
      #sb-preview-notice { position:fixed; left:0; right:0; bottom:0; height:var(--sb-preview-gutter); padding:6px 8px; padding-left:max(8px, env(safe-area-inset-left, 0px)); box-sizing:border-box; z-index:2147483647; pointer-events:none; }
      #sb-preview-notice #sb-preview-pill { border:1px solid #ad8128; border-radius:999px; padding:4px 10px; font:12px/1.5 system-ui,sans-serif; }`;
  const FACTS = 'This is a preview build of an unmerged branch. There are no accounts or cloud sync. Your work stays in this browser. The preview expires in 14 days; your browser’s stored work is separate.';
  const show = () => {
    if (document.getElementById('sb-preview-pill')) return;
    const style = document.createElement('style');
    style.textContent = `
      #sb-preview-pill { pointer-events:auto; border:1px solid #ad8128; border-radius:999px; background:#fff0c9; color:#513600; padding:0 8px; font:600 11px/1.6 system-ui,sans-serif; cursor:pointer; white-space:nowrap; flex:none; }
      #sb-preview-dialog { box-sizing:border-box; max-width:min(440px, calc(100vw - 24px)); max-height:calc(100dvh - 32px); overflow:auto; padding:20px; border:1px solid #888; border-radius:12px; font:14px/1.5 system-ui,sans-serif; }
      #sb-preview-dialog h2 { margin:0 0 12px; font:600 19px/1.4 system-ui,sans-serif; }
      #sb-preview-dialog code { overflow-wrap:anywhere; white-space:normal; }
      #sb-preview-dialog button { margin:6px 8px 0 0; padding:7px 10px; font:inherit; cursor:pointer; }
    `;
    const dockStyle = document.createElement('style');
    dockStyle.textContent = DOCK_CSS;
    document.head.append(style);
    const dock = document.getElementById('sb-preview-notice') ?? document.createElement('div');
    dock.id = 'sb-preview-notice';
    const pill = document.createElement('button');
    pill.id = 'sb-preview-pill'; pill.type = 'button';
    pill.textContent = 'PREVIEW, not production';
    pill.setAttribute('aria-haspopup', 'dialog');
    const dialog = document.createElement('dialog');
    dialog.id = 'sb-preview-dialog'; dialog.setAttribute('aria-labelledby', 'sb-preview-title');
    const title = document.createElement('h2'); title.id = 'sb-preview-title'; title.textContent = 'About this preview';
    const facts = document.createElement('p');
    facts.textContent = FACTS;
    const source = document.createElement('p');
    const label = document.createElement('span'); label.textContent = 'Built from branch ';
    const branch = document.createElement('code'); branch.textContent = config.source.branch;
    const commitLabel = document.createElement('span'); commitLabel.textContent = ', commit ';
    const commit = document.createElement('code'); commit.textContent = config.source.commit;
    source.append(label, branch, commitLabel, commit);
    if (config.source.dirty) source.append(' (including uncommitted changes)');
    const hide = document.createElement('button'); hide.type = 'button'; hide.textContent = 'Hide for this session';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close';
    let watch = null;
    hide.onclick = () => {
      try { sessionStorage.setItem(key, '1'); } catch {} // Storage disabled: hide on this page only.
      watch?.disconnect();
      dialog.close(); pill.remove(); dock.remove(); dialog.remove(); style.remove(); dockStyle.remove();
    };
    close.onclick = () => dialog.close();
    pill.onclick = () => dialog.showModal();
    dialog.append(title, facts, source, hide, close);
    document.body.append(dialog);
    const docked = () => { document.head.append(dockStyle); dock.append(pill); document.body.append(dock); };
    const inBanner = (banner) => {
      dockStyle.remove(); dock.remove(); banner.prepend(pill);
      // (the early-alpha notice dismissed: the pill goes back to its own dock)
      watch?.disconnect();
      watch = new MutationObserver(() => { if (!banner.isConnected) { watch.disconnect(); watch = null; docked(); } });
      watch.observe(document.body, { childList: true });
    };
    const banner = document.getElementById('sb-alpha-banner');
    if (banner) return inBanner(banner);
    docked();
    // (a notice that comes a moment later, its script after this one: the pill moves into it)
    const until = Date.now() + 3000;
    watch = new MutationObserver(() => {
      const b = document.getElementById('sb-alpha-banner');
      if (b) inBanner(b); else if (Date.now() > until) { watch.disconnect(); watch = null; }
    });
    watch.observe(document.body, { childList: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, { once: true });
  else show();
}
