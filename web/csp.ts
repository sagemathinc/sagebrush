// The _headers of the site (web/site/public) and of web/dist (web/serve.py):
// web/_headers, then every HTML page's Content-Security-Policy
// (web/csp-policy.mts).  Run by web/build.ts and web/demo/jfm/build.sh after
// they write pages, or `bun web/csp.ts`.  The pages under one top-level
// directory share a rule (/board/*) allowing all their inline scripts by
// hash; rules never overlap (two matching rules would be two policies, both
// enforced).  Fails if a page is left without a policy that allows its own
// scripts.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { pagePolicy, runnerPolicy } from "./csp-policy.mts";

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
    for (const pattern of g.patterns) rules.push([pattern, (g.patterns[0] === "/runner/*" ? runnerPolicy : pagePolicy)([...g.hashes].sort())]);
  // every page: exactly one policy, allowing each of its scripts
  for (const p of pages(dir)) {
    const need = scriptHashes(readFileSync(join(dir, p), "utf8"));
    for (const u of urls(p)) {
      const hit = rules.filter(([pattern]) => matches(pattern, u));
      if (hit.length !== 1) throw new Error(`csp: ${u} matches ${hit.length} policies`);
      for (const h of need) if (!hit[0][1].includes(h)) throw new Error(`csp: ${u}'s policy does not allow its script ${h}`);
    }
  }
  const base = readFileSync(join(here, "_headers"), "utf8").trimEnd();
  return `${base}\n# every page's Content-Security-Policy (written by web/csp.ts)\n${rules.map(([pattern, csp]) => `${pattern}\n  Content-Security-Policy: ${csp}`).join("\n")}\n`;
}

export function writeHeaders() {
  for (const dir of [join(here, "site", "public"), join(here, "dist")]) if (existsSync(dir)) writeFileSync(join(dir, "_headers"), headersFor(dir));
}

if (import.meta.main) writeHeaders();
