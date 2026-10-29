// The diagnostics of web/workspace/test-doc-sync.mjs: every line it prints about the sync API, the sockets, the pages
// and a stopped case 14 is emitted here, and nowhere else.  Two kinds of line:
// - structured: built from allow-listed fields only (a method from a fixed set, a path's safe characters before any
//   query or fragment, a status, a time, a socket's number and close code, a device letter, an owner state, a turn-on
//   phase from the page's fixed vocabulary);
// - free text (a page's console, the Sync panel's text, an error message): only through scrub(), which drops, line by
//   line, everything after a credential-like key (quoted, JSON-escaped, HTML- or %-encoded, any case: cookie,
//   authorization, session, token, secret, password, auth, bearer, credential, api key, sid, jwt, signature), a bearer
//   or basic value to the end of its line, a URL's userinfo, every query and fragment (absolute http/https/ws/wss,
//   relative, %- or entity-encoded) to the end of its line (never stopping at a quote or a
//   backslash), and every opaque run of 24 or more token characters; control characters become spaces; lines are
//   joined with " | ".  scrub() is idempotent on its own output, and every structured line passes it unchanged (no
//   "#", no key, no query), so `--filter` can scrub everything again.
// Nothing is printed raw.  `bun doc-sync-diag.mjs --controls` (the VM run's pre-step) sends sentinel secrets in each of
// those forms and harmless method/path lines through these same emitters to stdout, then checks what they printed;
// the VM judge checks the whole run.log too (no sentinel anywhere, every harmless marker kept).
// Every output of test-doc-sync.mjs is one of the formatters below (it has no console.* of
// its own): the aggregate failures with the page errors, the SHOW lines, the ok line, a step, the deadline, the outer
// catch, the bundle-build, harness-import and enable failures, a census hook's failure; and guardConsole() sends any
// in-process console call (the reference server's warns, the cloud harness's JavaScript) through scrub().  The
// printers are saved when this file loads, so a guarded console never loops back; the controls drive every formatter
// and the guarded console with the shapes the test hands them.
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
// (case 14 under cloud: the network receipts of the relay control (case R) and case 14, every field
// allow-listed, and no printed token 24 characters or longer, so neither scrub() nor --filter changes a line: a net::
// code is printed as its words ("ERR INCOMPLETE CHUNKED ENCODING"), a sha256 as four 16-hex groups)
const pageWord = (p) => word(p, /^(D1|D2|R)$/, "other");
const routeWord = (r) => word(r, /^(plain|old|new)$/, "other");
/** A traced call's id, "<page>.<n>" (the page's tracing fetch numbers its calls; the page makes it unique), else "none". */
const callId = (c) => { const m = /^(D1|D2|R)\.(\d{1,6})$/.exec(String(c ?? "")); return m ? `${m[1]}.${m[2]}` : "none"; };
const TE = new Set(["chunked", "identity"]), CE = new Set(["br", "gzip", "deflate", "zstd", "identity"]);
const hv = (v, set) => (v === null || v === undefined || v === "" ? "-" : set.has(String(v).trim().toLowerCase()) ? String(v).trim().toLowerCase() : "other");
/** One answer's transport headers ({te, ce, mfce, cl}: transfer-encoding, content-encoding, mf-content-encoding, content-length). */
const hdrs = (h) => `te=${hv(h?.te, TE)} ce=${hv(h?.ce, CE)} mfce=${hv(h?.mfce, CE)} cl=${h?.cl === null || h?.cl === undefined ? "absent" : "present"}`;
/** A net:: error code as its words ("net::ERR_INCOMPLETE_CHUNKED_ENCODING" is "ERR INCOMPLETE CHUNKED ENCODING"), else "other". */
const netCode = (c) => { const m = /^net::(ERR(?:_[A-Z0-9]{1,23}){1,8})$/.exec(String(c ?? "")); return m ? m[1].split("_").join(" ") : "other"; };
/** A sha256 (64 hex) as four 16-hex groups, else "?". */
const shaGroups = (h) => (/^[0-9a-f]{64}$/.test(String(h)) ? String(h).match(/.{16}/g).join(" ") : "?");
const STAGE = /^(fetch-rejected|fetched|body-read-failed|json-parse-failed|parsed)$/;
const stageDetail = (d) => (d === undefined ? "" : " " + (typeof d === "number" ? int(d) : word(d, /^[A-Za-z]{1,40}$/, "other")));
// (case R's R4.  The relay control's pairs, the k-th old call with the k-th new one (case R issues
// them in that order, old then new, k = 1..n), are its comparison groups: each member must have EXACTLY ONE upstream
// receipt, of its own route, status 200, its transport tuple (te, ce, mfce as known words; content-length absent or its
// value, 1 to 10 digits (the declared length is compared, not only its presence)) without an "other",
// and a byte receipt (not failed); the two
// members' tuples must be equal and their bytes the same (length and sha256); under cloud the tuple must carry a
// transport header (te, ce or mfce), under the reference server none.  Anything else fails the group, with its word.)
/** Case R's matched pairs: `pairs` [{old, new}], each member {route, ups: [{route, status, h}], relay: {n, sha} | {failed}}; `n` pairs wanted. */
export function pairCheck(pairs, cloud, n) {
  const clWord = (v) => (v === null || v === undefined ? "absent" : /^\d{1,10}$/.test(String(v)) ? String(Number(v)) : "other");
  const tuple = (h) => `te=${hv(h?.te, TE)} ce=${hv(h?.ce, CE)} mfce=${hv(h?.mfce, CE)} cl=${clWord(h?.cl)}`;
  const member = (m, route) => {
    const ups = m?.ups ?? [];
    if (ups.length === 0) return ["missing"];
    if (ups.length > 1) return ["duplicate"];
    if (ups[0].route !== route) return ["unmatched-route"];
    if (ups[0].status !== 200) return ["status"];
    const t = tuple(ups[0].h);
    if (t.includes("other")) return ["other-variant"];
    if (!m.relay) return ["no-receipt"];
    if (m.relay.failed !== undefined || !/^[0-9a-f]{64}$/.test(String(m.relay.sha)) || !Number.isInteger(m.relay.n)) return ["receipt-failed"];
    return [null, t];
  };
  const words = (pairs ?? []).map((p) => {
    const [ow, ot] = member(p?.old, "old"), [nw, nt] = member(p?.new, "new");
    if (ow) return `old-${ow}`;
    if (nw) return `new-${nw}`;
    if (ot !== nt) return "unmatched";
    if (p.old.relay.n !== p.new.relay.n || p.old.relay.sha !== p.new.relay.sha) return "bytes-differ";
    const carries = !/^te=- ce=- mfce=- /.test(ot);
    if (cloud && !carries) return "no-transport";
    if (!cloud && carries) return "transport";
    return `ok ${ot}`;
  });
  return { ok: words.length === n && words.every((w) => w.startsWith("ok ")), words: words.length === n ? words : [...words, `pairs ${int(words.length)} of ${int(n)}`] };
}

const KEY = String.raw`[\w-]*(?:cookie|authori[sz]ation|session|token|secret|passw(?:or)?d|auth|bearer|credential|api[-_]?key|apikey|sid|jwt|signature)[\w-]*`;
const QUOTE = String.raw`(?:\\*["'\x60]|&quot;|&#34;|&#x22;|%22)*`;
const SEP = String.raw`\s*(?:[:=]|%3a|%3d|&#58;|&#61;)`;
const KEYED = new RegExp(String.raw`(^|[^A-Za-z0-9])(${QUOTE}${KEY}${QUOTE}${SEP})[\s\S]*$`, "i");
/** Free text, made safe to print: see the header.  At most `n` characters. */
export function scrub(text, n = 300) {
  const lines = String(text ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r\n|\r|\n|\u2028|\u2029|\\r\\n|\\n|\\r/);
  // (the rules apply to the lines joined, so a redaction runs to the end of the text, across the lines after it,
  // and scrub(scrub(x)) is scrub(x): --filter's second pass changes nothing it printed)
  const r = rules(lines.join(" | "));
  // (cut to n, then the rules once more: a cut through a marker ("<redac") is made whole again, never half a value)
  return r.length <= n ? r : rules(r.slice(0, n));
}
// (scrub()'s rules, in order, on the joined text; idempotent on their own output)
function rules(s) {
  return s
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(KEYED, "$1$2<redacted>")
    .replace(/\b(bearer|basic|digest|negotiate)\s+\S[\s\S]*$/i, "$1 <redacted>")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/gi, "$1<redacted>@")
    .replace(/(?:[?#]|%3f|%23|&#63;|&#35;)(?=\S)[\s\S]*$/i, "?<dropped>")
    .replace(/[A-Za-z0-9+/_=-]{24,}/g, "<opaque>");
}

// (the last 60 structured front lines, for a stopped case)
const recent = [];
// (the printers, saved now: guardConsole() replaces console's methods later; `tap` is the controls' copy of each line)
const rawLog = console.log.bind(console), rawErr = console.error.bind(console);
let tap = null;
const out = (s) => { tap?.push(s); rawLog(s); };
const err = (s) => { tap?.push(s); rawErr(s); };
// (one console argument as text: an Error as its stack, a string as itself, anything else as JSON)
const arg = (x) => {
  if (x instanceof Error) return x.stack ?? String(x);
  if (typeof x === "string") return x;
  try { return JSON.stringify(x) ?? String(x); } catch { return String(x); }
};
const front = (s) => { recent.push(s); if (recent.length > 60) recent.shift(); out(s); };
export const emit = {
  syncStart: (k, m, p) => front(`front sync ${int(k)} start ${safeMethod(m)} ${safePath(p)}`),
  syncEnd: (k, m, p, status, ms) => front(`front sync ${int(k)} end ${safeMethod(m)} ${safePath(p)} ${int(status)} ${int(ms)}ms`),
  syncError: (k, m, p, name, ms) => front(`front sync ${int(k)} end ${safeMethod(m)} ${safePath(p)} error ${word(name, /^[A-Za-z]{1,40}$/, "Error")} ${int(ms)}ms`),
  sockOpen: (k, dev) => front(`front socket ${int(k)} open (device ${word(dev, /^[A-D]$/, "?")})`),
  sockUp: (k, ms) => front(`front socket ${int(k)} upstream open ${int(ms)}ms`),
  sockNoUp: (k, ms) => front(`front socket ${int(k)} no upstream ${int(ms)}ms`),
  sockServerClosed: (k, code) => front(`front socket ${int(k)} closed by the server ${int(code)}`),
  sockClosed: (k, code) => front(`front socket ${int(k)} closed ${int(code)}`),
  /** Free text, scrubbed. */
  text: (prefix, s, n = 300) => out(safePrefix(prefix) + scrub(s, n)),
  /** A page's turn-on phases, each from the fixed vocabulary. */
  phases: (prefix, list) => out(safePrefix(prefix) + (Array.isArray(list) ? list.slice(-10).map(phase).join("; ") || "(none)" : "(none)")),
  /** A page's owner state: its fields, typed. */
  owner: (prefix, st) => out(safePrefix(prefix) + (st && typeof st === "object"
    ? `holder ${st.holder === true} state ${word(st.state, /^[a-z_-]{1,24}$/, "?")} running ${st.running === true} connected ${int(st.connected)}`
    : "(none)")),
  /** The sync requests still waiting: number, method, path, age. */
  waiting: (prefix, list) => out(safePrefix(prefix) + "sync requests still waiting: " + (list.map(({ k, method, path, ms }) => `${int(k)} ${safeMethod(method)} ${safePath(path)} ${int(ms)}ms`).join("; ") || "none")),
  /** The sockets open (their numbers) and the totals. */
  counts: (prefix, open, sockets, requests) => out(safePrefix(prefix) + `sockets open: ${open.map(int).join(" ") || "none"} of ${int(sockets)}; sync requests ${int(requests)}`),
  /** The last n structured front lines, as they were printed. */
  recent: (prefix, n = 60) => { const r = recent.slice(-n); out(safePrefix(prefix) + `the front's last ${r.length} line(s):`); for (const s of r) out(safePrefix(prefix) + "  " + s); },
  // ---- every other output of test-doc-sync.mjs
  /** A step: its time and name (scrubbed). */
  step: (secs, what) => out(`step ${Number.isFinite(secs) ? secs.toFixed(1) : "?"}s: ${scrub(what, 120)}`),
  /** A census hook that failed: its checkpoint name and exit status. */
  census: (name, rc) => out(`CENSUS AT ${word(name, /^[a-z0-9:-]{1,40}$/, "?")} FAILED (its script's rc ${int(rc)})`),
  /** The suite's success line. */
  ok: (n) => out(`ok: notebooks' contents between two devices, ${int(n)} checks`),
  /** Every check's text (SHOW), scrubbed. */
  show: (results) => { for (const [, what] of results) out("  " + scrub(what, 2000)); },
  /** The failed checks and the page errors, as one FAIL block, each text scrubbed; returns how many. */
  failures: (results, errors) => {
    const fails = [...results.filter(([ok]) => !ok).map(([, what]) => what), ...errors.map((e) => "page error: " + e)];
    if (fails.length) { err(`FAIL: ${int(fails.length)} of ${int(results.length)} checks`); for (const f of fails) err("  " + scrub(f, 2000)); }
    return fails.length;
  },
  /** The run's deadline: where it was, and the page errors so far. */
  deadline: (step, errors) => { err("FAIL: the run's deadline passed at step: " + scrub(step, 200)); for (const e of errors) err("page error: " + scrub(e, 2000)); },
  /** The outer catch: the error's stack (or value), scrubbed. */
  crash: (e) => err("FAIL: " + scrub(arg(e), 4000)),
  /** The page bundle's build failed: its logs, scrubbed. */
  buildFail: (logs) => err("FAIL: the page bundle didn't build: " + scrub((logs ?? []).map(arg).join("\n"), 4000)),
  /** SERVER=cloud without cloud's harness: the import's error, scrubbed. */
  harnessFail: (e) => err("FAIL: SERVER=cloud needs cloud's web/sync/test-harness.mjs (run under cloud's scripts/with-core.sh): " + scrub(e?.message ?? arg(e), 600)),
  /** The account's enable didn't answer active: its answer, scrubbed. */
  enableFail: (answer) => err("FAIL: enable: " + scrub(arg(answer), 600)),
  // ---- the relay control's and case 14's network receipts (see the helpers above)
  /** At the front, before any relay: the upstream answer's status and transport headers, for a traced call and route. */
  upHdrs: (call, route, status, h) => front(`up-hdrs ${callId(call)} ${routeWord(route)} ${int(status)} ${hdrs(h)}`),
  /** The front's byte receipt for one relayed answer: its length and sha256. */
  relay: (call, route, n, sha) => front(`relay ${callId(call)} ${routeWord(route)} bytes ${int(n)} sha ${shaGroups(sha)}`),
  /** The front's byte receipt couldn't be made (its bounded read failed or timed out): the error's name. */
  relayFail: (call, route, name) => front(`relay ${callId(call)} ${routeWord(route)} receipt-failed ${word(name, /^[A-Za-z]{1,40}$/, "other")}`),
  /** The browser's view of one traced request (CDP): its response's status and transport headers. */
  netResp: (page, call, route, status, h) => out(`net-resp ${pageWord(page)} ${callId(call)} ${routeWord(route)} ${int(status)} ${hdrs(h)}`),
  /** The browser's view: the request's body loaded completely. */
  netDone: (page, call, route) => out(`net-done ${pageWord(page)} ${callId(call)} ${routeWord(route)}`),
  /** The browser's view: the request failed, with its net:: code. */
  netFail: (page, call, route, code) => out(`net-fail ${pageWord(page)} ${callId(call)} ${routeWord(route)} ${netCode(code)}`),
  /** The page's tracing fetch: one stage of a call (fetch-rejected <name>, fetched <status>, body-read-failed <name>,
   * json-parse-failed, parsed). */
  stage: (call, kind, detail) => out(`stage ${callId(call)} ${word(kind, STAGE, "other")}${stageDetail(detail)}`),
  /** The page's own byte receipt for a call it loaded: the length and sha256 of the bytes it received. */
  pageBytes: (call, n, sha) => out(`page-bytes ${callId(call)} bytes ${int(n)} sha ${shaGroups(sha)}`),
};
/** Every in-process console call from here on (the reference server's warns, the cloud harness's JavaScript, anything
 * else in this process) printed as "console: " + its scrubbed text; returns a function restoring the console. */
export function guardConsole() {
  const saved = Object.fromEntries(["log", "info", "debug", "warn", "error"].map((m) => [m, console[m]]));
  for (const m of ["log", "info", "debug"]) console[m] = (...a) => out("console: " + scrub(a.map(arg).join(" "), 2000));
  for (const m of ["warn", "error"]) console[m] = (...a) => err("console: " + scrub(a.map(arg).join(" "), 2000));
  return () => Object.assign(console, saved);
}

// ---- the controls (the VM run's pre-step): sentinels through the emitters above, checked
// (pairCheck's controls, case R's R4 rule on fixed receipts: a matched cloud group and a matched reference group
// pass; each way a group can be incomplete, duplicated, unmatched or unknown fails, with its word)
function pairControls() {
  const A = "a".repeat(64), B = "b".repeat(64);
  const CH = { te: "chunked", ce: null, mfce: "br", cl: null }, PL = { te: null, ce: null, mfce: null, cl: "17" };
  const m = (route, h, relay = { n: 17, sha: A }, status = 200) => ({ ups: [{ route, status, h }], relay });
  const pair = (h, o = {}, nw = {}) => ({ old: { ...m("old", h), ...o }, new: { ...m("new", h), ...nw } });
  const three = (p) => [pair(CH), p, pair(CH)];
  const fails = (name, pairs, cloud, want) => {
    const r = pairCheck(pairs, cloud, 3);
    return [`pair rule: ${name} fails (${want})`, !r.ok && r.words.some((w) => w === want)];
  };
  return [
    ["pair rule: three matched cloud groups pass", pairCheck([pair(CH), pair(CH), pair(CH)], true, 3).ok],
    ["pair rule: three matched reference groups pass", pairCheck([pair(PL), pair(PL), pair(PL)], false, 3).ok],
    fails("an unmatched receipt (old chunked, new not)", three(pair(CH, {}, m("new", PL))), true, "unmatched"),
    fails("a new-header-only mutation (only the new answer loses mf-content-encoding)", three(pair(CH, {}, m("new", { ...CH, mfce: null }))), true, "unmatched"),
    fails("a new-header-only mutation under the reference server (only the new answer chunked)", [pair(PL), pair(PL, {}, m("new", { ...PL, te: "chunked" })), pair(PL)], false, "unmatched"),
    fails("a new-content-length-value-only mutation (17 and 1, both present, the same 17 bytes)", [pair(PL), pair(PL, {}, m("new", { ...PL, cl: "1" })), pair(PL)], false, "unmatched"),
    fails("an old-content-length-value-only mutation under cloud (1 and 17, both present, the same 17 bytes)", three(pair({ ...CH, cl: "17" }, m("old", { ...CH, cl: "1" }))), true, "unmatched"),
    fails("a content-length that isn't one decimal number", three(pair({ ...CH, cl: "17, 17" })), true, "old-other-variant"),
    fails("a different status", three(pair(CH, {}, m("new", CH, undefined, 503))), true, "new-status"),
    fails("a missing upstream receipt", three(pair(CH, { ups: [] })), true, "old-missing"),
    fails("a duplicate upstream receipt", three(pair(CH, {}, { ups: [m("new", CH).ups[0], m("new", CH).ups[0]] })), true, "new-duplicate"),
    fails("a receipt of the other route", three(pair(CH, { ups: m("new", CH).ups })), true, "old-unmatched-route"),
    fails("an unknown variant", three(pair({ ...CH, mfce: "x-gzip2" })), true, "old-other-variant"),
    fails("no byte receipt", three(pair(CH, { relay: undefined })), true, "old-no-receipt"),
    fails("a failed byte receipt", three(pair(CH, { relay: { failed: "TimeoutError" } })), true, "old-receipt-failed"),
    fails("different bytes", three(pair(CH, {}, { relay: { n: 17, sha: B } })), true, "bytes-differ"),
    fails("no transport header under cloud", [pair(PL), pair(PL), pair(PL)], true, "no-transport"),
    fails("a transport header under the reference server", [pair(CH), pair(CH), pair(CH)], false, "transport"),
    fails("two groups of three", [pair(CH), pair(CH)], true, "pairs 2 of 3"),
  ];
}
function controls() {
  // (each sentinel is made here, never written whole in this file; the judge looks for its stem in the whole run.log)
  const S = (i) => ["SN", "TL", String(i).padStart(2, "0")].join("");
  // (a full sha256's shape, 64 hex, for the byte receipts)
  const SHA17 = "0123456789abcdef".repeat(4);
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
    `KEEP-11 first line\nAuThOrIzAtIoN: ${S(17)}\nthird line (redacted too: a redaction runs to the end of the text)`,
    `KEEP-13 /api/sync%3Fsid%3D${S(18)}`,
    `KEEP-14 wss://user:${S(19)}@host/x`,
    `KEEP-15 Bearer ${S(20)}`,
    `KEEP-16 eyJhbGciOiJIUzI1NiJ9${S(22)}abcdefghijkl`,
    `KEEP-17 &quot;authorization&quot;:&quot;${S(23)}&quot;`,
    `KEEP-18 Set-Cookie: sb_session=${S(24)}; Path=/`,
    `KEEP-19 'cookie': '${S(29)}' and \`token\`=${S(30)}`,
    `KEEP-12 first\\nX-Auth-Token: ${S(31)}\\r\\nafter an escaped newline (redacted too)`,
    `KEEP-22 the panel says Turn on sync? then Sync turned on (200 ms)`,
  ];
  // (quoted query and fragment values, plain and as said/warnings are printed: J of an array of strings)
  const quoted = [
    `KEEP-36 wss://host/api?x='${S(60)}' tail`,
    `KEEP-37 https://host/a?x="${S(61)}" tail`,
    `KEEP-38 /api/sync#"${S(62)}" tail`,
    `KEEP-39 page#'${S(63)}'`,
    JSON.stringify([`KEEP-40 say: panel wss://h/a?x="${S(64)}" more`, `warn: x#"${S(65)}"`]),
    JSON.stringify([`KEEP-41 warn: panel https://h/b?y=\"${S(66)}\" more`]),
  ];
  const printed = [];
  tap = printed;
  const restore = guardConsole();
  // (each formatter and the guarded console, with the shapes test-doc-sync hands them)
  const results = [
    [true, "1: a passing check KEEP-23"],
    [false, `14: the case stopped: KEEP-24 D1: {"exceptionDetails":{"text":"Uncaught","exception":{"description":"Error: GET wss://h/api/sync?sid=${S(40)}"}}}`],
    [false, `13: the case stopped: KEEP-25 Error: Authorization: Bearer ${S(41)}`],
  ];
  const errors = [`TypeError: fetch failed KEEP-26 https://u:${S(42)}@x/y?token=${S(43)}`];
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
    for (const [i, q] of quoted.entries()) emit.text(`diag-control quoted ${i + 1}: `, q, 600);
    emit.step(2.5, `D1.turnOn?x=${S(44)}`);
    emit.ok(5);
    emit.show(results);
    emit.failures(results, errors);
    emit.deadline(`D1.turnOn?x=${S(45)}`, [`KEEP-27 Error: secret=${S(46)}`]);
    emit.crash(new Error(`boom KEEP-28 token: ${S(47)}`));
    emit.buildFail(["KEEP-30 a build log line", `KEEP-29 error: Could not resolve "x" at /tmp/x.js?v=${S(48)}`]);
    emit.harnessFail(new Error(`KEEP-31 Cannot find module file:///x/test-harness.mjs#${S(49)} more`));
    emit.enableFail({ note: "KEEP-32", state: "off", cookie: S(50) });
    // (the network receipts, with the longest net:: codes and a full sha256, and wrong values that must fall back)
    emit.upHdrs("R.1", "old", 200, { te: "chunked", ce: null, mfce: "br", cl: null });
    emit.upHdrs("R.2", "new", 200, { te: "Chunked ", ce: "x-evil", mfce: undefined, cl: "17" });
    emit.relay("R.1", "old", 17, SHA17);
    emit.relayFail("R.3", "old", "TimeoutError");
    emit.netResp("R", "R.1", "old", 200, { te: "chunked", ce: null, mfce: "br", cl: null });
    emit.netDone("D1", "D1.12", "plain");
    emit.netFail("R", "R.1", "old", "net::ERR_INCOMPLETE_CHUNKED_ENCODING");
    emit.netFail("R", "R.2", "old", "net::ERR_CONTENT_DECODING_FAILED");
    emit.netFail("Q", "R.3", "bogus", `net::err ${S(80)}`);
    emit.stage("R.1", "fetch-rejected", "TypeError");
    emit.stage("R.2", "body-read-failed", `Type${S(81)}`);
    emit.stage("R.4", "parsed");
    emit.stage(`R.5?${S(82)}`, "fetched", 200);
    emit.pageBytes("R.4", 17, SHA17);
    emit.pageBytes("R.4", 17, `nothex${S(83)}`);
    console.warn("reference server:", new Error(`KEEP-33 stale Authorization: Bearer ${S(51)}`));
    console.log("KEEP-34 a harness note", { url: `ws://h/x?sid=${S(52)}` });
    console.error(`KEEP-35 a product error with session=${S(53)}`);
  } finally {
    restore();
    tap = null;
  }
  const stem = S(0).slice(0, 4);
  const keeps3 = quoted.flatMap((t) => t.match(/KEEP-\d\d/g));
  const keeps2 = ["KEEP-23", "KEEP-24", "KEEP-25", "KEEP-26", "KEEP-27", "KEEP-28", "KEEP-29", "KEEP-30", "KEEP-31", "KEEP-32", "KEEP-33", "KEEP-34", "KEEP-35"];
  const keeps = [...fixtures.flatMap((t) => t.match(/KEEP-\d\d/g)), ...keeps2, ...keeps3];
  const exact = [
    "front sync 1 start GET /api/sync/v1/status",
    "front sync 2 end POST /api/sync/v1/enable 200 12ms",
    "front sync 3 end POST /api/sync/v1/enable error Error 7ms",
    "front socket 4 open (device D)",
    "front socket 4 upstream open 3ms",
    "front socket 4 closed by the server 1006",
    "front socket 4 closed 1000",
    "diag-control phases: panel made (1 ms); clicked (5 ms); ?",
    "diag-control owner: holder true state ? running true connected 1",
    "diag-control: sync requests still waiting: 5 GET /api/sync/v1/x 900ms",
    "diag-control: sockets open: 4 of 4; sync requests 3",
    `diag-control ${fixtures.length}: KEEP-22 the panel says Turn on sync? then Sync turned on (200 ms)`,
    "step 2.5s: D1.turnOn?<dropped>",
    "ok: notebooks' contents between two devices, 5 checks",
    "  1: a passing check KEEP-23",
    `FAIL: ${results.filter(([ok]) => !ok).length + errors.length} of ${results.length} checks`,
    "FAIL: the run's deadline passed at step: D1.turnOn?<dropped>",
    "  13: the case stopped: KEEP-25 Error: Authorization:<redacted>",
    "console: KEEP-35 a product error with session=<redacted>",
    "diag-control quoted 1: KEEP-36 wss://host/api?<dropped>",
    "diag-control quoted 2: KEEP-37 https://host/a?<dropped>",
    "diag-control quoted 3: KEEP-38 /api/sync?<dropped>",
    "diag-control quoted 4: KEEP-39 page?<dropped>",
    'diag-control quoted 5: ["KEEP-40 say: panel wss://h/a?<dropped>',
    'diag-control quoted 6: ["KEEP-41 warn: panel https://h/b?<dropped>',
  ];
  // (the network receipts' exact lines; each must also pass scrub() unchanged (the runner's --filter scrubs every
  // line again), and the forms they avoid must not: a whole net:: code and a whole sha256 are opaque runs)
  const g = SHA17.match(/.{16}/g).join(" ");
  const netLines = [
    "up-hdrs R.1 old 200 te=chunked ce=- mfce=br cl=absent",
    "up-hdrs R.2 new 200 te=chunked ce=other mfce=- cl=present",
    `relay R.1 old bytes 17 sha ${g}`,
    "relay R.3 old receipt-failed TimeoutError",
    "net-resp R R.1 old 200 te=chunked ce=- mfce=br cl=absent",
    "net-done D1 D1.12 plain",
    "net-fail R R.1 old ERR INCOMPLETE CHUNKED ENCODING",
    "net-fail R R.2 old ERR CONTENT DECODING FAILED",
    "net-fail other R.3 other other",
    "stage R.1 fetch-rejected TypeError",
    "stage R.2 body-read-failed other",
    "stage R.4 parsed",
    "stage none fetched 200",
    `page-bytes R.4 bytes 17 sha ${g}`,
    "page-bytes R.4 bytes 17 sha ?",
  ];
  const cases = [
    ["no sentinel in any printed line", printed.every((l) => !l.includes(stem))],
    ...keeps.map((k) => [`${k} kept`, printed.some((l) => l.includes(k))]),
    ...exact.map((e) => [`exact: ${e}`, printed.includes(e)]),
    ["one line per fixture", fixtures.every((_, i) => printed.filter((l) => l.startsWith(`diag-control ${i + 1}: `)).length === 1)],
    ...netLines.map((e) => [`network receipt exact: ${e}`, printed.includes(e)]),
    ["every network receipt line passes scrub() unchanged (so --filter keeps it)", netLines.every((l) => scrub(l, 4000) === l)],
    ["a whole net:: code and a whole sha256 would be scrubbed (why they are printed as words and groups)",
      scrub("net::ERR_INCOMPLETE_CHUNKED_ENCODING").includes("<opaque>") && scrub(SHA17) === "<opaque>"],
    ...pairControls(),
  ];
  let k = 0;
  for (const [i, [name, ok]] of cases.entries()) { if (ok) k++; rawLog(`DIAG CONTROL ${i + 1} ${ok ? "PASS" : "FAIL"}: ${name}`); }
  // (raw lines with sentinels written straight to stdout, as Miniflare/workerd or Bun itself would: the runner pipes
  // this run through --filter, and the judge requires every marker kept and no sentinel in run.log)
  const top = Math.max(...keeps.map((m) => Number(m.slice(5))));
  const external = [
    `KEEP-${top + 1} workerd: GET /api/sync/v1/x?token=${S(70)} 200`,
    `KEEP-${top + 2} error: Uncaught Error: Authorization: Bearer ${S(71)}`,
    `KEEP-${top + 3} [mf] wss://u:${S(72)}@h/api?x='${S(73)}'`,
    `KEEP-${top + 4} {"cookie":"sb_session=${S(74)}"}`,
  ];
  for (const x of external) rawLog(x);
  // (every marker the run must keep, listed for the judge: these and the external ones, each in some other line)
  const markers = [...keeps, ...external.map((x) => x.split(" ")[0])];
  rawLog(`DIAG CONTROL MARKERS ${markers.join(" ")}`);
  rawLog(`DIAG CONTROL FIXTURES ${fixtures.length} KEEPS ${markers.length}`);
  rawLog(`DIAG CONTROLS ${k} of ${cases.length} PASS`);
  process.exit(k === cases.length ? 0 : 1);
}
// ---- --filter (the runner's pipe for the suites and the controls): every line of stdin scrubbed to stdout, between
// a start line and an end line counting them (the judge checks the section holds exactly those lines): whatever the
// test process, Miniflare/workerd or Bun itself writes reaches run.log only through scrub()
async function filter() {
  rawLog("DIAG FILTER START");
  let n = 0, buf = "";
  const dec = new TextDecoder();
  const line = (s) => { rawLog(scrub(s, 4000)); n++; };
  for await (const chunk of process.stdin) {
    buf += dec.decode(chunk, { stream: true });
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) line(buf.slice(0, i));
  }
  buf += dec.decode();
  if (buf) line(buf);
  rawLog(`DIAG FILTER END ${n} line(s)`);
}
const main = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main && process.argv.includes("--controls")) controls();
else if (main && process.argv.includes("--filter")) await filter();
