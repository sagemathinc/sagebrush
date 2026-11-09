// "Learn more": a link from a panel's one short line into the docs (web/build-docs.ts), where the explanations are
// (William, Nov 8: no wall of text in the app). On the site the link is the same origin's, so DEV's links stay on DEV;
// in the desktop app, whose pages aren't the site's, it is sagebrush.space's.
export const DOCS_SITE = "https://sagebrush.space";

/** The address of docs page `path` ("storage#sync"). */
export function docsHref(path: string, loc: { protocol: string } | undefined = globalThis.location): string {
  const site = !!loc && /^https?:$/.test(loc.protocol) && !(globalThis as any).__TAURI__;
  return `${site ? "" : DOCS_SITE}/docs/${path}`;
}

/** A "Learn more" link to docs page `path`, opened in a new tab. */
export function learnMore(path: string, text = "Learn more"): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = "learn";
  a.href = docsHref(path);
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = text;
  return a;
}
