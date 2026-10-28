// The diagnostics of web/workspace/test-doc-sync.mjs: every line it prints about the sync API, the sockets, the pages
// and a stopped case 14 is emitted here, and nowhere else.  Two kinds of line:
// - structured: built from allow-listed fields only (a method from a fixed set, a path's safe characters before any
//   query or fragment, a status, a time, a socket's number and close code, a device letter, an owner state, a turn-on
//   phase from the page's fixed vocabulary);
// - free text (a page's console, the Sync panel's text, an error message): only through scrub(), which drops, line by
//   line, everything after a credential-like key (quoted, JSON-escaped, HTML- or %-encoded, any case: cookie,
//   authorization, session, token, secret, password, auth, bearer, credential, api key, sid, jwt, signature), a bearer
//   or basic value, a URL's userinfo, every query and fragment (absolute http/https/ws/wss, relative, %-encoded), and
//   every opaque run of 24 or more token characters; control characters become spaces; lines are joined with " | ".
// Nothing is printed raw.  `bun doc-sync-diag.mjs --controls` (the VM run's pre-step) sends sentinel secrets in each of
// those forms and harmless method/path lines through these same emitters to stdout, then checks what they printed;
// the VM judge checks the whole run.log too (no sentinel anywhere, every harmless marker kept).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const int = (n) => (Number.isSafeInteger(n) && n >= 0 && n < 1e9 ? String(n) : "?");
const word = (s, re, other) => (re.test(String(s)) ? String(s) : other);
/** A path's safe form: the part before any query or fragment (plain or %-encoded), [A-Za-z0-9/_.-] only, at most 120. */
export const safePath = (p) => String(p ?? "").split(/[?#]|%3f|%23/i)[0].replace(/[^A-Za-z0-9/_.-]/g, "_").slice(0, 120);
const safeMethod = (m) => (METHODS.has(String(m).toUpperCase()) ? String(m).toUpperCase() : "?");
// (a line's prefix: this file's callers' own labels, checked)
const safePrefix = (p) => word(p, /^[A-Za-z0-9 :_'-]{0,48}$/, "?: ");
// (the page's turn-on phases (test-doc-sync.page.js's T.turnOn), each "<name> (<n> ms)"; anything else is "?")
const PHASES = new Set(["panel made", "its Turn on sync button shown", "clicked", "the holder, synced", "the wait for the holder, synced, ended without it"]);
const phase = (s) => { const m = /^(.*) \((\d{1,9}) ms\)$/.exec(String(s)); return m && PHASES.has(m[1]) ? `${m[1]} (${m[2]} ms)` : "?"; };

const KEY = String.raw`[\w-]*(?:cookie|authori[sz]ation|session|token|secret|passw(?:or)?d|auth|bearer|credential|api[-_]?key|apikey|sid|jwt|signature)[\w-]*`;
const QUOTE = String.raw`(?:\\*["'\x60]|&quot;|&#34;|&#x22;|%22)*`;
const SEP = String.raw`\s*(?:[:=]|%3a|%3d|&#58;|&#61;)`;
const KEYED = new RegExp(String.raw`(^|[^A-Za-z0-9])(${QUOTE}${KEY}${QUOTE}${SEP})[\s\S]*$`, "i");
/** Free text, made safe to print: see the header.  At most `n` characters. */
export function scrub(text, n = 300) {
  const lines = String(text ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r\n|\r|\n|\u2028|\u2029|\\r\\n|\\n|\\r/);
  const out = lines.map((s) => s
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(KEYED, "$1$2<redacted>")
    .replace(/\b(bearer|basic|digest|negotiate)\s+\S+/gi, "$1 <redacted>")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, "$1<redacted>@")
    .replace(/(?:[?#]|%3f|%23|&#63;|&#35;)[^\s"'`<>\\]+/gi, "?<dropped>")
    .replace(/[A-Za-z0-9+/_=-]{24,}/g, "<opaque>"));
  return out.join(" | ").slice(0, n);
}

// (the last 60 structured front lines, for a stopped case)
const recent = [];
const out = (s) => console.log(s);
const front = (s) => { recent.push(s); if (recent.length > 60) recent.shift(); out(s); };
export const emit = {
  syncStart: (k, m, p) => front(`front sync #${int(k)} start ${safeMethod(m)} ${safePath(p)}`),
  syncEnd: (k, m, p, status, ms) => front(`front sync #${int(k)} end ${safeMethod(m)} ${safePath(p)} ${int(status)} ${int(ms)}ms`),
  syncError: (k, m, p, name, ms) => front(`front sync #${int(k)} end ${safeMethod(m)} ${safePath(p)} error ${word(name, /^[A-Za-z]{1,40}$/, "Error")} ${int(ms)}ms`),
  sockOpen: (k, dev) => front(`front socket #${int(k)} open (device ${word(dev, /^[A-D]$/, "?")})`),
  sockUp: (k, ms) => front(`front socket #${int(k)} upstream open ${int(ms)}ms`),
  sockNoUp: (k, ms) => front(`front socket #${int(k)} no upstream ${int(ms)}ms`),
  sockServerClosed: (k, code) => front(`front socket #${int(k)} closed by the server ${int(code)}`),
  sockClosed: (k, code) => front(`front socket #${int(k)} closed ${int(code)}`),
  /** Free text, scrubbed. */
  text: (prefix, s, n = 300) => out(safePrefix(prefix) + scrub(s, n)),
  /** A page's turn-on phases, each from the fixed vocabulary. */
  phases: (prefix, list) => out(safePrefix(prefix) + (Array.isArray(list) ? list.slice(-10).map(phase).join("; ") || "(none)" : "(none)")),
  /** A page's owner state: its fields, typed. */
  owner: (prefix, st) => out(safePrefix(prefix) + (st && typeof st === "object"
    ? `holder ${st.holder === true} state ${word(st.state, /^[a-z_-]{1,24}$/, "?")} running ${st.running === true} connected ${int(st.connected)}`
    : "(none)")),
  /** The sync requests still waiting: number, method, path, age. */
  waiting: (prefix, list) => out(safePrefix(prefix) + "sync requests still waiting: " + (list.map(({ k, method, path, ms }) => `#${int(k)} ${safeMethod(method)} ${safePath(path)} ${int(ms)}ms`).join("; ") || "none")),
  /** The sockets open (their numbers) and the totals. */
  counts: (prefix, open, sockets, requests) => out(safePrefix(prefix) + `sockets open: ${open.map(int).join(" ") || "none"} of ${int(sockets)}; sync requests ${int(requests)}`),
  /** The last n structured front lines, as they were printed. */
  recent: (prefix, n = 60) => { const r = recent.slice(-n); out(safePrefix(prefix) + `the front's last ${r.length} line(s):`); for (const s of r) out(safePrefix(prefix) + "  " + s); },
};

// ---- the controls (the VM run's pre-step): sentinels through the emitters above, checked
function controls() {
  // (each sentinel is made here, never written whole in this file; the judge looks for its stem in the whole run.log)
  const S = (i) => ["SN", "TL", String(i).padStart(2, "0")].join("");
  const fixtures = [
    `KEEP-01 cookie: __Host-sb_session=${S(1)}; theme=${S(2)}`,
    `KEEP-02 Authorization: Bearer ${S(3)}`,
    `KEEP-03 {"authorization":"Bearer ${S(4)}","cookie":"sb=${S(5)}"}`,
    `KEEP-04 {\\"Cookie\\":\\"sb_session=${S(6)}\\"}`,
    `KEEP-05 fetch failed: http://127.0.0.1:8787/api/sync/v1/enable?token=${S(7)}#${S(8)}`,
    `KEEP-06 GET https://x.test/a?${S(9)} failed`,
    `KEEP-07 ws://127.0.0.1:1/api/sync/v1/account?dev=D&sid=${S(10)}`,
    `KEEP-08 WebSocket WSS://host/api/sync?sid=${S(11)}#${S(12)}`,
    `KEEP-09 relative /api/sync/v1/status?x=${S(13)} and v1/account?${S(14)} and page#${S(15)}`,
    `KEEP-10 mixed CoOkIe = ${S(16)}`,
    `KEEP-11 first line\nAuThOrIzAtIoN: ${S(17)}\nKEEP-12 third line`,
    `KEEP-13 /api/sync%3Fsid%3D${S(18)}`,
    `KEEP-14 wss://user:${S(19)}@host/x`,
    `KEEP-15 Bearer ${S(20)}`,
    `KEEP-16 eyJhbGciOiJIUzI1NiJ9${S(22)}abcdefghijkl`,
    `KEEP-17 &quot;authorization&quot;:&quot;${S(23)}&quot;`,
    `KEEP-18 Set-Cookie: sb_session=${S(24)}; Path=/`,
    `KEEP-19 'cookie': '${S(29)}' and \`token\`=${S(30)}`,
    `KEEP-20 first\\nX-Auth-Token: ${S(31)}\\r\\nKEEP-21 after an escaped newline`,
    `KEEP-22 the panel says Turn on sync? then Sync turned on (200 ms)`,
  ];
  const printed = [];
  const real = console.log;
  console.log = (...a) => { const s = a.map(String).join(" "); printed.push(s); real(s); };
  try {
    for (const [i, t] of fixtures.entries()) emit.text(`diag-control ${i + 1}: `, t, 600);
    emit.syncStart(1, "GET", `/api/sync/v1/status?sid=${S(25)}`);
    emit.syncEnd(2, "POST", "/api/sync/v1/enable", 200, 12);
    emit.syncError(3, "post", `/api/sync/v1/enable#${S(26)}`, `TypeError ${S(27)}`, 7);
    emit.sockOpen(4, "D");
    emit.sockUp(4, 3);
    emit.sockServerClosed(4, 1006);
    emit.sockClosed(4, 1000);
    emit.phases("diag-control phases: ", ["panel made (1 ms)", "clicked (5 ms)", `evil ${S(28)} (2 ms)`]);
    emit.owner("diag-control owner: ", { holder: true, state: `synced ${S(32)}`, running: true, connected: 1 });
    emit.waiting("diag-control: ", [{ k: 5, method: "GET", path: `/api/sync/v1/x?${S(33)}`, ms: 900 }]);
    emit.counts("diag-control: ", [4], 4, 3);
    emit.recent("diag-control recent: ", 3);
  } finally {
    console.log = real;
  }
  const stem = S(0).slice(0, 4);
  const keeps = fixtures.flatMap((t) => t.match(/KEEP-\d\d/g));
  const exact = [
    "front sync #1 start GET /api/sync/v1/status",
    "front sync #2 end POST /api/sync/v1/enable 200 12ms",
    "front sync #3 end POST /api/sync/v1/enable error Error 7ms",
    "front socket #4 open (device D)",
    "front socket #4 upstream open 3ms",
    "front socket #4 closed by the server 1006",
    "front socket #4 closed 1000",
    "diag-control phases: panel made (1 ms); clicked (5 ms); ?",
    "diag-control owner: holder true state ? running true connected 1",
    "diag-control: sync requests still waiting: #5 GET /api/sync/v1/x 900ms",
    "diag-control: sockets open: 4 of 4; sync requests 3",
    `diag-control ${fixtures.length}: KEEP-22 the panel says Turn on sync? then Sync turned on (200 ms)`,
  ];
  const cases = [
    ["no sentinel in any printed line", printed.every((l) => !l.includes(stem))],
    ...keeps.map((k) => [`${k} kept`, printed.some((l) => l.includes(k))]),
    ...exact.map((e) => [`exact: ${e}`, printed.includes(e)]),
    ["one line per fixture", fixtures.every((_, i) => printed.filter((l) => l.startsWith(`diag-control ${i + 1}: `)).length === 1)],
  ];
  let k = 0;
  for (const [i, [name, ok]] of cases.entries()) { if (ok) k++; real(`DIAG CONTROL ${i + 1} ${ok ? "PASS" : "FAIL"}: ${name}`); }
  real(`DIAG CONTROL FIXTURES ${fixtures.length} KEEPS ${keeps.length}`);
  real(`DIAG CONTROLS ${k} of ${cases.length} PASS`);
  process.exit(k === cases.length ? 0 : 1);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes("--controls")) controls();
