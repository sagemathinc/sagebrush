// The isolated output renderer's two forms (OUT-ISO plan r3, phase 1), built from one
// script (web/output-shell/shell.js):
// - hosted: dist/output-shell/index.html, served from its own cookie-free site with
//   outputShellPolicy() as its response header (web/csp.ts); its URL per environment
//   is pinned in web/output-shell/sites.mts, empty until that site exists;
// - packaged: the same page as a srcdoc (local server, desktop app, exported files),
//   the policy in a meta tag, the same script hash.  A srcdoc frame also inherits its
//   parent's policy; both apply.
// The script is inlined (no request, no file the frame could be pointed at instead) and
// the policy admits it by its sha-256 alone.
import { createHash } from "node:crypto";
import { outputShellPolicy } from "../csp-policy.mts";

const STYLE = `html,body{margin:0;padding:0;background:transparent;color:#111;font:14px/1.45 system-ui,sans-serif;overflow:hidden}
html[data-theme=dark]{color:#e8e8e8}html[data-theme=contrast]{color:#000;background:#fff}
#root{display:flow-root}section.out{overflow-x:auto}pre{margin:0;white-space:pre-wrap;font:13px/1.4 ui-monospace,monospace}
table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:2px 6px}img,svg{max-width:100%}`;

const hash = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

export async function buildOutputShell(build: (o: any) => Promise<any>, entry: string): Promise<{ hosted: string; srcdoc: string; scriptHash: string; styleHash: string }> {
  const r = await build({ entrypoints: [entry], target: "browser", format: "iife", minify: true, sourcemap: "none" });
  if (!r.success) throw new Error("the output shell didn't build:\n" + r.logs.join("\n"));
  const js = (await r.outputs[0].text()).replace(/<\/script/gi, "<\\/script");
  const scriptHash = hash(js), styleHash = hash(STYLE);
  const page = (meta: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">${meta}<title>output</title><style>${STYLE}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
  const policy = outputShellPolicy([scriptHash], [styleHash]);
  return {
    hosted: page(""),
    srcdoc: page(`<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, "&quot;")}">`),
    scriptHash,
    styleHash,
  };
}
