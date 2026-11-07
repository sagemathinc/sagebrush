// Content-host configuration shared by the files Worker and its API binding.
// William supplies the new names and performs DNS/deploys. Empty values keep
// today's files routes; they do not enable hosted execution or rendering.
export type ContentEnvironment = "dev" | "prod";
export const LEGACY_CONTENT_ROOTS = Object.freeze(["cocalcusercontent.com", "cocalcusercontent.dev"]);
const legacyFiles = { dev: `https://files.${LEGACY_CONTENT_ROOTS[1]}`, prod: `https://files.${LEGACY_CONTENT_ROOTS[0]}` };
export const CONTENT_DOMAINS = Object.freeze({
  dev: { root: "", filesOrigin: "", runOrigin: "", renderOrigin: "" },
  prod: { root: "", filesOrigin: "", runOrigin: "", renderOrigin: "" },
});
export type ContentDomains = typeof CONTENT_DOMAINS;

// All new values are exact origins, not URL prefixes or wildcard routes.
// roots remain different across environments; role hosts are fixed, and no
// hosted role is switched on by this preparation change.
export function checkContentDomains(config: ContentDomains = CONTENT_DOMAINS): string[] {
  const problems: string[] = [];
  for (const env of ["dev", "prod"] as const) {
    const c = config[env];
    if (c.root && (!/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?\.(?:com|dev)$/.test(c.root) || !c.root.endsWith(env === "dev" ? ".dev" : ".com") || LEGACY_CONTENT_ROOTS.includes(c.root))) problems.push(`${env}: choose a dedicated ${env === "dev" ? ".dev" : ".com"} content root`);
    for (const [key, role] of [["filesOrigin", "files"], ["runOrigin", "run"], ["renderOrigin", "render"]] as const) {
      if (!c[key]) continue;
      if (!c.root || c[key] !== `https://${role}.${c.root}`) problems.push(`${env}: ${key} must be the exact https ${role} origin under its content root`);
    }
  }
  if (config.dev.root && config.dev.root === config.prod.root) problems.push("dev and prod must use different content roots");
  return problems;
}
export function filesOrigin(env: ContentEnvironment, config: ContentDomains = CONTENT_DOMAINS): string {
  const problems = checkContentDomains(config);
  if (problems.length) throw new Error(problems.join("; "));
  return config[env].filesOrigin || legacyFiles[env];
}
export const filesHost = (env: ContentEnvironment, config: ContentDomains = CONTENT_DOMAINS): string => new URL(filesOrigin(env, config)).hostname;
// Keep old raw download links working during the reviewed dual-host cutover.
export const filesHosts = (env: ContentEnvironment, config: ContentDomains = CONTENT_DOMAINS): string[] => [...new Set([new URL(legacyFiles[env]).hostname, filesHost(env, config)])];
// Until real-host isolation gates and PSL/browser adoption are reviewed,
// neither a pending root nor its role hosts are eligible output-shell sites.
export function forbiddenContentRoots(config: ContentDomains = CONTENT_DOMAINS): string[] {
  return [...LEGACY_CONTENT_ROOTS, ...Object.values(config).map((c) => c.root).filter(Boolean)];
}
