// What looks like a secret in a file about to be shared (Share folder, book links B2; @sagebrush's Nov 4 ruling:
// a file holding a key-like string starts unticked, with the reason and where). Small on purpose: a known key's
// shape anywhere, or a long hex or base64 token assigned to a name saying key, token, secret or password. It reads
// text only, line by line, and says the first finding of a file; a miss is possible, so the author still decides.

export interface SecretHit {
  /** 1-based line of the text given (for a notebook, of its cell) */
  line: number;
  /** what it looks like: "an API key", "a private key", … */
  what: string;
}

// (known shapes: each provider's own prefix and length)
const KNOWN: [RegExp, string][] = [
  [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/, "a private key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}/, "a GitHub token"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/, "an API key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/\b[rs]k_live_[0-9A-Za-z]{24,}/, "a Stripe key"],
];
// (a name that says what it holds, then =, : or =>, then a quoted value: in Python, R, JSON, YAML, shell, a
// notebook's source; the quote may be escaped, as in a .ipynb's JSON)
const NAMED = /(api[_-]?key|apikey|access[_-]?key|secret|token|passw(?:or)?d|passwd|private[_-]?key|auth)[\w-]*\\?["']?\s*(?:=>|=|:)\s*\\?["']([^"'\\\s]{16,})\\?["']/i;
const HEX = /^[0-9a-f]{20,}$/i;
const B64 = /^[A-Za-z0-9+/_-]{24,}={0,2}$/;

/** A value that is a long hex or base64 token: long, with no spaces, and of mixed letters and digits. */
function tokenLike(v: string): boolean {
  if (HEX.test(v)) return /[0-9]/.test(v) && /[a-f]/i.test(v);
  return B64.test(v) && /[0-9]/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v);
}

/** The first line of `text` that looks like it holds a secret, or null. At most `maxLines` lines are read. */
export function findSecret(text: string, maxLines = 100_000): SecretHit | null {
  const lines = text.split("\n", maxLines);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > 10_000) continue;
    for (const [re, what] of KNOWN) if (re.test(l)) return { line: i + 1, what };
    const m = NAMED.exec(l);
    if (m && tokenLike(m[2])) return { line: i + 1, what: /pass/i.test(m[1]) ? "a password" : /token|auth/i.test(m[1]) ? "a token" : "an API key" };
  }
  return null;
}

/** A file name that is itself a secret's (read or not): .env files, SSH keys, credential files. */
export function secretName(name: string): string | null {
  const n = name.toLowerCase();
  if (n === ".env" || n.startsWith(".env.")) return "an environment file (.env)";
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(n) || n.endsWith(".pem") || n.endsWith(".key")) return "a private key file";
  if (n === "credentials" || n === "credentials.json" || n === ".netrc" || n === ".pgpass") return "a credentials file";
  return null;
}

/** The files whose text is read for secrets: text by their name (data such as .csv is left out: a key is not kept
 * there, and it is often large). */
export const SCANNED = /\.(py|sage|ipynb|r|jl|m|sh|txt|md|json|ya?ml|toml|ini|cfg|conf|js|ts)$/i;

/** The warning's words: "looks like it contains an API key: qrpm_funcs.py:12". */
export function secretWarning(file: string, hit: SecretHit | { what: string; line?: undefined }, cell?: number): string {
  const at = hit.line === undefined ? file : cell === undefined ? `${file}:${hit.line}` : `${file}, cell ${cell}, line ${hit.line}`;
  return `looks like it contains ${hit.what}: ${at}`;
}
