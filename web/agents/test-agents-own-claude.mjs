// ci: web-artifacts.1 order=34 runner=bun chrome
// "Use your own Claude" (#1604): the help box's command is the release's one-liner on the origins sagebrush-agent
// trusts by default (sagebrush.space, agents.sagebrush.cloud), and adds --origin with the page's own origin anywhere
// else (a DEV or preview site, a local server), so pairing works there. Its rule (own-claude.ts), then the built page
// served locally: the release's line from the page's HTML, with --origin http://127.0.0.1:<port>.
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/agents/test-agents-own-claude.mjs
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServe } from "../test-port.mjs";
import { browser } from "./a14-cases.mjs";
import { ownClaudeCommand, shellWord } from "./own-claude.ts";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 400) : "")); if (!c) failures++; };

// ---- the rule
const base = "npx -y https://agents.sagebrush.cloud/agents/sagebrush-agent-9.9.9.tgz";
ok(ownClaudeCommand(base, "https://sagebrush.space") === base && ownClaudeCommand(base, "https://agents.sagebrush.cloud") === base, "on the origins the agent trusts by default: the one-liner as it is");
ok(ownClaudeCommand(base, "https://dev.sagebrush.space") === base + " --origin https://dev.sagebrush.space", "on DEV: --origin https://dev.sagebrush.space");
ok(ownClaudeCommand(base, "http://127.0.0.1:8765") === base + " --origin http://127.0.0.1:8765", "on a local server: --origin with its port");
ok(ownClaudeCommand(base, "http://[::1]:8765") === base + " --origin 'http://[::1]:8765'", "an IPv6 literal: --origin, quoted (its brackets are a shell pattern)", ownClaudeCommand(base, "http://[::1]:8765"));
ok(ownClaudeCommand(base, "https://[2001:db8::1]") === base + " --origin 'https://[2001:db8::1]'", "an IPv6 literal on https's default port: --origin, quoted");
ok(ownClaudeCommand(base, "https://xn--bcher-kva.example") === base + " --origin https://xn--bcher-kva.example", "a punycode host: --origin, as it is");
// (every line read back by a real POSIX shell: its words exactly npx, -y, the tarball, --origin and the origin, for
//  origins that hold every character a shell reads specially that a canonical origin can hold)
// (a line the shell can't read, or reads as other words, is a failed row, not a crash)
const argv = (line) => { try { return execFileSync("sh", ["-c", `printf '%s\\0' ${line}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\0").slice(0, -1); } catch (e) { return "the shell refused it: " + String(e.message).slice(0, 80); } };
const hosts = ["dev.sagebrush.space", "127.0.0.1:8765", "[::1]:8765", "[2001:db8::1]", "a'b.example", "a$b.example", "a;b.example", "a&b.example", "a(b).example", "a*b.example", "a`b.example", "a!b.example", 'a"b.example', "a{b}.example", "a~b.example", "it's'.example"];
const trips = hosts.map((h) => { const o = new URL(`https://${h}`).origin; const words = argv(ownClaudeCommand(base, o)); return { o, ok: JSON.stringify(words) === JSON.stringify(["npx", "-y", base.split(" ")[2], "--origin", o]), words }; });
ok(trips.every((t) => t.ok), "through a real shell, every command's words are exactly npx -y <tarball> --origin <origin>, for origins with ' $ ; & ( ) * ` ! \" { } ~ and IPv6 brackets", trips.filter((t) => !t.ok));
ok(shellWord("a'b") === "'a'\\''b'" && shellWord("https://x.org") === "https://x.org", "shellWord: a single quote closed, escaped and reopened; a plain origin as it is");
ok(["null", "https://a b", "https://x.org/path", "ftp://x.org", "https://X.org", "http://x.org:80"].every((o) => ownClaudeCommand(base, o) === base), "not an origin as the URL parser gives one back (a file page's \"null\", a space, a path, another scheme, upper case, a default port): the one-liner, nothing appended");

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
