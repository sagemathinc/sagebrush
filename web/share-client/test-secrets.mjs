// ci: web-sync.4 order=31 runner=bun
// Share folder's secret check (web/share-client/secrets.ts; book links B2, @sagebrush's Nov 4 ruling): what looks
// like a key is found, with its line; what only names one, or reads it from the environment, is not.
//   bun web/share-client/test-secrets.mjs
// (with QRPM_KEYLESS=<path to a keyless qrpm_funcs.py>, also: that file is clean, and the same file with a key put
// into it is found at that line; the file itself is private and never committed)
import { readFileSync } from "node:fs";
import { findSecret, secretName, secretWarning, SCANNED } from "./secrets.ts";

let checks = 0;
const fails = [];
const ok = (cond, what) => {
  checks++;
  console.log((cond ? "ok   " : "FAIL ") + what);
  if (!cond) fails.push(what);
};
// (made-up values of each shape, never real ones)
const HEX32 = "0123456789abcdef0123456789abcdef";
const B64 = "Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MGFi";
const found = [
  [`fred = Fred(api_key='${HEX32}')`, "an API key"],
  [`FRED_API_KEY = "${HEX32}"`, "an API key"],
  [`    "api_key = \\"${HEX32}\\"\\n",`, "an API key"], // (a .ipynb's JSON: escaped quotes)
  [`{"apiKey": "${B64}"}`, "an API key"],
  [`token: ${"'"}${B64}${"'"}`, "a token"],
  [`AUTH_TOKEN="${B64}"`, "a token"],
  [`db_password = "${B64}"`, "a password"],
  [`client_secret='${HEX32}'`, "an API key"],
  [`key = "AKIA${"ABCDEFGHIJKLMNOP"}"`, "an AWS access key"],
  [`-----BEGIN RSA PRIVATE KEY-----`, "a private key"],
  [`-----BEGIN OPENSSH PRIVATE KEY-----`, "a private key"],
  [`g = Github("ghp_${"a1".repeat(18)}")`, "a GitHub token"],
  [`client = OpenAI(api_key=os.environ.get("X", "sk-proj-${"Ab1".repeat(12)}"))`, "an API key"],
  [`url = "https://hooks.slack.com/x?t=xoxb-1234567890-abcdef"`, "a Slack token"],
  [`GOOGLE = "AIza${"B".repeat(35)}"`, "a Google API key"],
  [`stripe.api_key = "sk_live_${"a1B".repeat(9)}"`, "a Stripe key"],
];
for (const [line, what] of found) {
  const h = findSecret("import os\n\n" + line + "\nprint(1)\n");
  ok(h?.line === 3 && h.what === what, `found on line 3 as ${what}: ${line.slice(0, 60)} (${JSON.stringify(h)})`);
}
const clean = [
  "api_key = os.environ.get('FRED_API_KEY')",
  "api_key=os.environ['FRED_API_KEY']",
  "#an API key. Each reader uses their own key: set the",
  "# https://fred.stlouisfed.org/docs/api/api_key.html",
  `api_key = input("Your FRED key: ")`,
  `password = "hunter2"`,
  `token = "<your token here>"`,
  `api_key = "YOUR_API_KEY_GOES_HERE_PLEASE"`,
  `sha = "${HEX32}"`,
  `checksum: "${"ab".repeat(32)}"`,
  `secret_word = "abcdefghijklmnopqrstuvwxyz"`,
  `key = "${"0".repeat(32)}"`,
  `api_key = "${"0".repeat(32)}"`,
  `api_key = "${"deadbeef".repeat(4)}"`,
  `x = "${B64}"`,
];
for (const line of clean) ok(findSecret(line + "\n") === null, `clean: ${line.slice(0, 60)}`);
ok(findSecret("") === null && findSecret("\n\n") === null, "an empty text is clean");
ok(findSecret("x\n".repeat(5) + `k = "AKIA${"A".repeat(16)}"`, 3) === null, "only maxLines lines are read");
ok(findSecret(`api_key="${HEX32}"` + " ".repeat(10_001)) === null, "a line longer than 10,000 characters is skipped");
ok(findSecret(`a = 1\napi_key="${HEX32}"\nfred_token="${B64}"`)?.line === 2, "the first finding is the one said");

for (const [n, want] of [[".env", true], [".env.local", true], ["id_rsa", true], ["id_ed25519", true], ["server.pem", true], ["tls.key", true], ["credentials.json", true], [".netrc", true], ["environment.yml", false], ["keys.csv", false], ["id_rsa.pub", false], ["notes.md", false]]) {
  ok(!!secretName(n) === want, `the name ${n} ${want ? "is" : "isn't"} a secret's (${secretName(n)})`);
}
for (const [n, want] of [["qrpm_funcs.py", true], ["ch1.ipynb", true], ["config.yaml", true], ["data.csv", false], ["fig.png", false], ["x.xlsx", false]]) {
  ok(SCANNED.test(n) === want, `${n} ${want ? "is" : "isn't"} read for secrets`);
}
ok(secretWarning("qrpm_funcs.py", { line: 12, what: "an API key" }) === "looks like it contains an API key: qrpm_funcs.py:12", "the warning names the file and line");
ok(secretWarning("ch1.ipynb", { line: 2, what: "a token" }, 4) === "looks like it contains a token: ch1.ipynb, cell 4, line 2", "…a notebook's, the cell and its line");
ok(secretWarning(".env", { what: "an environment file (.env)" }) === "looks like it contains an environment file (.env): .env", "…a file known by its name, the file");

const keyless = process.env.QRPM_KEYLESS;
if (keyless) {
  const text = readFileSync(keyless, "utf8");
  ok(findSecret(text) === null, `the keyless qrpm_funcs.py is clean (${JSON.stringify(findSecret(text))})`);
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /api_key\s*=\s*os\.environ/.test(l));
  ok(at >= 0, `(the keyless file reads its key from the environment, line ${at + 1})`);
  lines[at] = lines[at].replace(/os\.environ\.get\('FRED_API_KEY'\)/, `'${HEX32}'`);
  const h = findSecret(lines.join("\n"));
  ok(h?.line === at + 1 && h.what === "an API key", `…and with a key put on that line, it is found there (${JSON.stringify(h)})`);
} else console.log("(QRPM_KEYLESS not set: the keyless book file isn't checked here)");

console.log(fails.length ? `${fails.length} of ${checks} failed` : `all passed (${checks})`);
process.exit(fails.length ? 1 : 0);
