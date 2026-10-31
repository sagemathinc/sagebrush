// The _headers of the site (web/site/public) and of web/dist (web/serve.py):
// web/_headers, then every HTML page's Content-Security-Policy
// (web/csp-policy.mts).  Run by web/build.ts and web/demo/jfm/build.sh after
// they write pages, or `bun web/csp.ts`.  The pages under one top-level
// directory share a rule (/board/*) allowing all their inline scripts by
// hash; rules never overlap (two matching rules would be two policies, both
// enforced).  The runner's pages (web/runner, and its copies in the engines
// under engine/) get the runner's policy.  Fails if a page is left without a
// policy that allows its own scripts.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hasSite, siteDir } from "./site-dir.mts";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { frameOptions, framePolicy, pagePolicy, runnerPolicy, shellWorkerPolicy } from "./csp-policy.mts";
import { FILES_RUNNER_SCRIPT } from "./notebook/files-runner.js";

const here = dirname(new URL(import.meta.url).pathname);

function pages(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...pages(dir, p));
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

// The hashes of a page's inline scripts (data blocks, such as JSON-LD, never run).
export function scriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(m[1])?.[1].toLowerCase();
    if (type && !["module", "text/javascript", "application/javascript"].includes(type)) continue;
    out.push(`'sha256-${createHash("sha256").update(m[2]).digest("base64")}'`);
  }
  return out;
}

// (the runner's files-mode frame's one script: a frame's policy allows it, files-runner.js)
const runnerScriptHash = `'sha256-${createHash("sha256").update(FILES_RUNNER_SCRIPT).digest("base64")}'`;

// The URLs a page is served at.
const urls = (p: string) => (p === "index.html" ? ["/", "/index.html"] : p.endsWith("/index.html") ? ["/" + p.slice(0, -10), "/" + p] : ["/" + p, "/" + p.slice(0, -5)]);
const matches = (pattern: string, url: string) => url === pattern || (pattern.endsWith("*") && url.startsWith(pattern.slice(0, -1)));

export function headersFor(dir: string): string {
  const groups = new Map<string, { patterns: string[]; hashes: Set<string>; files: string[] }>();
  for (const p of pages(dir)) {
    const top = p.includes("/") ? p.slice(0, p.indexOf("/")) : p;
    const patterns = p.includes("/") ? [`/${top}/*`] : urls(p);
    const g = groups.get(top) ?? { patterns, hashes: new Set(), files: [] };
    for (const h of scriptHashes(readFileSync(join(dir, p), "utf8"))) g.hashes.add(h);
    g.files.push(p);
    groups.set(top, g);
  }
  const rules: [string, string][] = [];
  for (const g of [...groups.values()].sort((a, b) => a.patterns[0].localeCompare(b.patterns[0])))
    for (const pattern of g.patterns) rules.push([pattern, (g.patterns[0] === "/runner/*" || g.patterns[0] === "/engine/*" ? runnerPolicy : g.patterns[0] === "/frame/*" ? (h: string[]) => framePolicy(h, runnerScriptHash) : g.patterns[0] === "/agents/*" ? (h: string[]) => pagePolicy(h, "'none'") : pagePolicy)([...g.hashes].sort())]);
  // every page: exactly one policy, allowing each of its scripts
  for (const p of pages(dir)) {
    const need = scriptHashes(readFileSync(join(dir, p), "utf8"));
    for (const u of urls(p)) {
      const hit = rules.filter(([pattern]) => matches(pattern, u));
      if (hit.length !== 1) throw new Error(`csp: ${u} matches ${hit.length} policies`);
      for (const h of need) if (!hit[0][1].includes(h)) throw new Error(`csp: ${u}'s policy does not allow its script ${h}`);
    }
  }
  // (the runner's page and the frame's exactly as built: no-transform keeps
  // Cloudflare from adding its analytics script to them, which the runner's
  // policy would refuse anyway, and which a frame in others' pages shouldn't
  // have; the frame may be embedded by any page, even a cross-origin isolated
  // one: CORP)
  // the shell worker's script: a worker's policy is its own response's (plan-bash-shell r3 §6)
  if (existsSync(join(dir, "shell", "worker-boot.js"))) rules.push(["/shell/worker-boot.js", shellWorkerPolicy()]);
  const extra = (pattern: string) => (pattern === "/runner/*" || pattern === "/frame/*" ? "\n  Cache-Control: public, max-age=0, must-revalidate, no-transform" : "") + (pattern === "/frame/*" ? "\n  Cross-Origin-Resource-Policy: cross-origin" : "");
  // web/_headers, but a rule for a path a policy is written for goes into
  // that one rule: Cloudflare keeps only the last rule given for a path, so
  // the first's headers would be lost (HDR-A75-1); a path given twice is refused
  const own = new Map<string, string[]>();
  const base: string[] = [];
  let into: string[] | null = null;
  for (const line of readFileSync(join(here, "_headers"), "utf8").trimEnd().split("\n")) {
    if (line && !/^\s|^#/.test(line)) {
      into = rules.some(([p]) => p === line) ? (own.get(line) ?? own.set(line, []).get(line)!) : null;
      if (into) continue;
    } else if (into && /^\s/.test(line)) {
      into.push(line);
      continue;
    } else into = null;
    base.push(line);
  }
  // (each rule its policy's X-Frame-Options, for browsers without frame-ancestors: in the rule, never in /*,
  // as Cloudflare adds every matching rule's headers and the embeddable frame must have none)
  const xfo = (csp: string) => (frameOptions(csp) ? `\n  X-Frame-Options: ${frameOptions(csp)}` : "");
  const text = `${base.join("\n")}\n# every page's Content-Security-Policy (written by web/csp.ts)\n${rules.map(([pattern, csp]) => `${pattern}\n${(own.get(pattern) ?? []).map((l) => l + "\n").join("")}  Content-Security-Policy: ${csp}${xfo(csp)}${extra(pattern)}`).join("\n")}\n`;
  const paths = text.split("\n").filter((l) => l && !/^\s|^#/.test(l));
  const twice = paths.filter((p, i) => paths.indexOf(p) !== i);
  if (twice.length) throw new Error(`csp: _headers gives ${twice.join(", ")} more than one rule`);
  return text;
}

export function writeHeaders() {
  // (web/site's only when it is here: web/site-dir.mts)
  for (const dir of [...(hasSite ? [join(siteDir, "public")] : []), join(here, "dist")]) if (existsSync(dir)) writeFileSync(join(dir, "_headers"), headersFor(dir));
}

if (import.meta.main) writeHeaders();
