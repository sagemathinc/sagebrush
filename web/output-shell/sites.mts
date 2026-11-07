// Where the isolated output renderer is hosted, per environment (OUT-ISO plan r3): the
// shell's exact final URL (no redirect, pretty-URL redirects included) and the app pages
// that may show it (frame-ancestors).  Every `shell` is EMPTY until the dedicated,
// cookie-free site exists: a separate registrable domain from the app and from any site
// hosting user-published pages. Legacy and pending content roots remain forbidden
// until real-host isolation gates and PSL/browser adoption are reviewed.
// While a shell is empty, that environment uses the packaged srcdoc variant; it never
// falls back to inline rich output.  Filling one in is a reviewed change, with the
// hosted gates (final URL, headers, cookies, ancestors) rerun on that exact config first
// (daybreak3's ruling, Nov 7).  No DEV page may point at a production shell.
import { forbiddenContentRoots } from "../content-domains.mts";

export const SITES = Object.freeze({
  preview: { shell: "", ancestors: [] as string[] },
  dev: { shell: "", ancestors: ["https://dev.sagebrush.space"] },
  prod: { shell: "", ancestors: ["https://sagebrush.space"] },
});

/** The config's own checks: an https shell URL ending in /, not on an app or user-content site; no cross-environment shell. */
export function checkSites(sites: typeof SITES = SITES): string[] {
  const out: string[] = [];
  const site = (u: string) => new URL(u).hostname.split(".").slice(-2).join(".");
  const forbidden = new Set(["sagebrush.space", "sagebrush.cloud", ...forbiddenContentRoots()]);
  for (const [env, s] of Object.entries(sites)) {
    if (!s.shell) continue;
    let u: URL;
    try { u = new URL(s.shell); } catch { out.push(`${env}: the shell URL isn't a URL`); continue; }
    if (u.protocol !== "https:" || !u.pathname.endsWith("/") || u.search || u.hash) out.push(`${env}: the shell URL must be https, end in /, with no query or fragment`);
    if (forbidden.has(site(s.shell))) out.push(`${env}: the shell may not share the app's or the user-content site (${site(s.shell)})`);
    for (const [other, t] of Object.entries(sites)) if (other !== env && t.shell && t.shell === s.shell) out.push(`${env} and ${other} share one shell`);
  }
  return out;
}
