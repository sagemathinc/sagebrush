// "Use your own Claude" (#1604): the command the help box shows, for the site the page is on. The release's one-liner
// (its tarball, named in the page's HTML) is enough where the agent trusts the page's origin by default; anywhere else
// (a DEV or preview site, a local server) the agent must be told the page's origin, or it refuses the page.
/** The origins sagebrush-agent trusts without --origin (its DEFAULT_ORIGINS). */
export const AGENT_DEFAULT_ORIGINS: readonly string[] = ["https://sagebrush.space", "https://agents.sagebrush.cloud"];

/** `base` (the release's npx line) for a page at `origin`: as it is on a default origin; with `--origin <origin>`
 * on any other http(s) origin (an origin has no spaces or quotes, so the line stays one shell word per part). */
export function ownClaudeCommand(base: string, origin: string): string {
  if (AGENT_DEFAULT_ORIGINS.includes(origin) || !/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) return base;
  return `${base} --origin ${origin}`;
}
