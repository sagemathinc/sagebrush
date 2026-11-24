// "Use your own Claude" (#1604): the command the help box shows, for the site the page is on. The release's one-liner
// (its tarball, named in the page's HTML) is enough where the agent trusts the page's origin by default; anywhere else
// (a DEV or preview site, a local server) the agent must be told the page's origin, or it refuses the page.
/** The origins sagebrush-agent trusts without --origin (its DEFAULT_ORIGINS). */
export const AGENT_DEFAULT_ORIGINS: readonly string[] = ["https://sagebrush.space", "https://agents.sagebrush.cloud"];

/** `base` (the release's npx line) for a page at `origin`: as it is on a default origin; with `--origin <origin>`
 * on any other http(s) origin, as the URL parser gives it back (an IPv6 literal's included), as one shell word
 * (shellWord); anything else (a file page's "null") as it is. */
export function ownClaudeCommand(base: string, origin: string): string {
  if (AGENT_DEFAULT_ORIGINS.includes(origin)) return base;
  let u: URL;
  try { u = new URL(origin); } catch { return base; }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.origin !== origin) return base;
  return `${base} --origin ${shellWord(origin)}`;
}

/** `s` as one POSIX shell word: as it is when it holds only characters no shell reads specially; else single-quoted,
 * each single quote in it closed, escaped and reopened ('\''). A canonical origin can hold ' $ ; & ( ) * ` ! and more. */
export function shellWord(s: string): string {
  return /^[A-Za-z0-9.:/_+=,@%-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}
