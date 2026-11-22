// ci: web-artifacts.1 order=34 runner=bun chrome
// "Use your own Claude" (#1604): the help box's command is the release's one-liner on the origins sagebrush-agent
// trusts by default (sagebrush.space, agents.sagebrush.cloud), and adds --origin with the page's own origin anywhere
// else (a DEV or preview site, a local server), so pairing works there. Its rule (own-claude.ts), then the built page
// served locally: the release's line from the page's HTML, with --origin http://127.0.0.1:<port>.
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/agents/test-agents-own-claude.mjs
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServe } from "../test-port.mjs";
import { browser } from "./a14-cases.mjs";
import { ownClaudeCommand } from "./own-claude.ts";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 400) : "")); if (!c) failures++; };

// ---- the rule
const base = "npx -y https://agents.sagebrush.cloud/agents/sagebrush-agent-9.9.9.tgz";
ok(ownClaudeCommand(base, "https://sagebrush.space") === base && ownClaudeCommand(base, "https://agents.sagebrush.cloud") === base, "on the origins the agent trusts by default: the one-liner as it is");
ok(ownClaudeCommand(base, "https://dev.sagebrush.space") === base + " --origin https://dev.sagebrush.space", "on DEV: --origin https://dev.sagebrush.space");
ok(ownClaudeCommand(base, "http://127.0.0.1:8765") === base + " --origin http://127.0.0.1:8765", "on a local server: --origin with its port");
ok(ownClaudeCommand(base, "null") === base && ownClaudeCommand(base, "https://a b") === base && ownClaudeCommand(base, "https://x.org/path") === base, "no http(s) origin (a file page's \"null\", anything with a space or a path): the one-liner, nothing appended");

// ---- the built page, served locally
const html = readFileSync(join(here, "..", "dist", "agents", "index.html"), "utf8");
const line = /<div id="help"[^]*?<pre>([^<]+)<\/pre>/.exec(html)?.[1].trim();
let server, Br;
try {
  const port = await startServe(() => (server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
  const site = `http://127.0.0.1:${port}`;
  Br = await browser();
  const P = await Br.tab();
  await P.navigate(`${site}/agents/`);
  // (the command as the page leaves it once its script has run: the box's text, shown or not)
  await P.until(`document.querySelector('#help pre')?.textContent.includes('--origin')`, 30000).catch(() => {});
  const shown = await P.ev(`document.querySelector('#help pre').textContent`);
  ok(/^npx -y https:\/\/agents\.sagebrush\.cloud\/agents\/sagebrush-agent-\d+\.\d+\.\d+\.tgz$/.test(line ?? "") && shown === `${line} --origin ${site}`, "the page on a local server: the release's line from its HTML, with --origin and the page's own origin", { line, shown });
  ok(P.errors.length === 0, "no page errors", P.errors);
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await Br?.close();
  server?.kill();
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
