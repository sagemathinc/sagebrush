// Preview-first UI only. The flag never selects or disables an interpreter.
export function createRunnerPill({ mount = document.body, enabled = new URLSearchParams(location.search).get('runner-info') === '1' } = {}) {
  if (!enabled) return { watch: () => () => {} };
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'No sandbox';
  button.title = 'About this browser’s code runner';
  button.setAttribute('aria-haspopup', 'dialog');
  button.hidden = true;
  button.style.cssText = 'border:1px solid #b98928;border-radius:999px;background:#fff0c9;color:#513600;padding:3px 10px;font:12px system-ui;cursor:pointer;white-space:nowrap';
  if (mount === document.body) button.style.cssText += ';position:fixed;bottom:16px;right:16px;z-index:1000';
  mount.append(button);
  let dialog;
  button.onclick = () => {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.setAttribute('aria-label', 'About the code sandbox');
      dialog.style.cssText = 'max-width:430px;border:1px solid #888;border-radius:12px;padding:24px;font:16px/1.5 system-ui;color:CanvasText;background:Canvas';
      const title = document.createElement('h2'); title.textContent = 'No sandbox in this browser'; title.style.marginTop = '0';
      const first = document.createElement('p');
      first.textContent = 'Code is running without the extra browser sandbox, so this layer of defense in depth is off. Your own code is fine to run.';
      const next = document.createElement('p');
      next.textContent = 'Prefer Chrome, where the sandbox is supported. A sandbox on a separate domain for all browsers is coming.';
      const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Got it'; close.onclick = () => dialog.close();
      dialog.append(title, first, next, close); document.body.append(dialog);
    }
    if (!dialog.open) dialog.showModal();
  };
  const observed = new Map();
  const refresh = () => {
    const plain = [...observed].some(([kernel, sandboxed]) => kernel.ready && kernel.worker && !sandboxed(kernel.worker));
    button.hidden = !plain;
    if (!plain && dialog?.open) dialog.close();
  };
  return {
    /** Observe actual ready workers, including a RunnerWorker's plain-worker fallback. */
    watch(kernel, sandboxed) {
      observed.set(kernel, sandboxed);
      const off = [kernel.on('ready', refresh), kernel.on('restart', refresh)];
      refresh();
      return () => { for (const stop of off) stop(); observed.delete(kernel); refresh(); };
    },
  };
}
