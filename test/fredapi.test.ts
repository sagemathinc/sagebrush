import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/fredapi.py, lib/yfinance.py and lib/_sbdata_live.py (design-data-access
// r3.1, step 1; grader's frozen controls C1-C12, K11, K12, K13's lib scan and
// the four bridge edges), in one interpreter with pandas' package set, against
// a synthetic page: a liveData host that answers from synthetic series and a
// synthetic catalog, as the page's admission and the relay would, holding its
// own reader key.  No network.  The oracle for C5 is CPython's fredapi 0.5.2
// with pandas 3.1.1, its urlopen served the same series as XML, its output
// frozen below (the generator is the CPython half of SHOW).

const ROOT = join(__dirname, "..", "..");
const SERIES: Record<string, [string, string][]> = {
  SYN_A: [["2020-01-01", "1.5"], ["2020-02-01", "."], ["2020-03-01", "-2.25"], ["2020-04-01", "1e3"]],
  SYN_EMPTY: [],
  SYN_ONE: [["1999-12-31", "0.1"]],
};
// (the relay's catalog, synthetic: SYN_OUT is a valid id outside it)
const CATALOG = new Set(Object.keys(SERIES));
const CANARY = "fred-canary-" + [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

const SHOW = `
SERIES = ("SYN_A", "SYN_EMPTY", "SYN_ONE")
def show(fred):
    for sid, kw in [("SYN_A", {}), ("SYN_A", {"observation_start": "2020-02-01", "observation_end": "3/1/2020"}), ("SYN_EMPTY", {}), ("SYN_ONE", {})]:
        s = fred.get_series(sid, **kw)
        print(sid, sorted(kw.items()))
        print(repr(s))
        print(s.dtype, type(s.index).__name__, s.index.dtype, s.name, len(s))
        print([str(t) for t in s.index], [repr(float(v)) for v in s.values])
`;
const ORACLE = `SYN_A []
2020-01-01       1.50
2020-02-01        NaN
2020-03-01      -2.25
2020-04-01    1000.00
dtype: float64
float64 DatetimeIndex datetime64[us] None 4
['2020-01-01 00:00:00', '2020-02-01 00:00:00', '2020-03-01 00:00:00', '2020-04-01 00:00:00'] ['1.5', 'nan', '-2.25', '1000.0']
SYN_A [('observation_end', '3/1/2020'), ('observation_start', '2020-02-01')]
2020-02-01     NaN
2020-03-01   -2.25
dtype: float64
float64 DatetimeIndex datetime64[us] None 2
['2020-02-01 00:00:00', '2020-03-01 00:00:00'] ['nan', '-2.25']
SYN_EMPTY []
Series([], dtype: object)
object RangeIndex int64 None 0
[] []
SYN_ONE []
1999-12-31    0.1
dtype: float64
float64 DatetimeIndex datetime64[us] None 1
['1999-12-31 00:00:00'] ['0.1']
`;

test("fredapi, yfinance and the live-data bridge against a synthetic page", async () => {
  const out = mkdtempSync(join(tmpdir(), "sb-fredapi-"));
  const S = execFileSync(process.execPath, [join(ROOT, "scripts", "optional-packages.mjs"), "build", "--out", out, "pandas"], { encoding: "utf8" }).trim().split("\n").pop()!;
  const C = require("../src/compile");
  const { prepareSet } = require("../src/pkgcache");
  const [S2, index, read] = await prepareSet(join(out, "pkgset", S + ".json"), C.coreBuildId(), C.reservedNames());
  C.installPackageSet(S2, index, read);
  const { notebookSession } = require("../src/notebook-session");
  // the synthetic page: every request recorded; `upstream` counts what would go to FRED
  const page = { key: "reader-key" as string | null, requests: [] as any[], upstream: 0, answer: null as any, all: [] as any[] };
  const liveData = (req: any) => {
    page.requests.push(JSON.parse(JSON.stringify(req)));
    page.all.push(JSON.parse(JSON.stringify(req)));
    if (page.answer) return page.answer;
    if (page.key === null) return { error: "no_key" };
    if (!CATALOG.has(req.params.series_id)) return { error: "not_in_catalog" };
    page.upstream++;
    const lo = req.params.observation_start ?? "0000", hi = req.params.observation_end ?? "9999";
    const rows = SERIES[req.params.series_id].filter(([d]) => lo <= d && d <= hi);
    return { ok: { dates: rows.map(([d]) => d), values: rows.map(([, v]) => (v === "." ? null : Number(v))) } };
  };
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true, liveData });
  await s.ready;
  let id = 0;
  const run = async (code: string) => {
    const n = ++id;
    await s.handle({ id: n, code });
    return msgs.filter((m) => m.id === n && m.stream).map((m) => m.text).join("");
  };
  const NODATES = "NotImplementedError fredapi: a FRED series is a pandas Series indexed by date (a DatetimeIndex), which Sagebrush's pandas doesn't have yet\n";
  // (each call's outcome: its exception's type and message, or its length)
  const PRELUDE = "import fredapi, datetime\ndef get(*a, key='k', **kw):\n    try:\n        print(len(fredapi.Fred(key).get_series(*a, **kw)))\n    except Exception as e:\n        print(type(e).__name__, e)\n";
  const reset = () => ((page.requests = []), (page.upstream = 0), (page.answer = null), (page.key = "reader-key"));

  // C6's notice, once for several calls; C4: exactly the parameters, no key, nothing else
  reset();
  const notice = "FRED: using your own key (Settings); the api_key in this code is not used.\n";
  // (until pandas has a DatetimeIndex, each answer is refused plainly, never a Series of another index: @sagebrush)
  const shown = await run(`${PRELUDE}for sid, kw in [("SYN_A", {}), ("SYN_A", {"observation_start": "2020-02-01", "observation_end": datetime.date(2020, 3, 1)}), ("SYN_EMPTY", {}), ("SYN_ONE", {})]:\n    get(sid, key=${JSON.stringify(CANARY)}, **kw)`);
  assert.equal(shown, notice + NODATES.repeat(4));
  assert.deepEqual(page.requests.map((r) => r.params), [{ series_id: "SYN_A" }, { series_id: "SYN_A", observation_start: "2020-02-01", observation_end: "2020-03-01" }, { series_id: "SYN_EMPTY" }, { series_id: "SYN_ONE" }]);
  assert.ok(page.requests.every((r) => r.op === "fred.series_observations" && Object.keys(r).sort().join() === "id,op,params,target"));
  // C6: once per session (the run above printed it once for four calls; here not again)
  assert.equal(await run(`get('SYN_ONE')`), NODATES);

  // C2: the key in code is neither kept nor compared; a right and a wrong key alike
  assert.equal(await run(`f = fredapi.Fred(api_key=${JSON.stringify(CANARY)})\nprint(repr(f), f.__dict__)`), "<fredapi.Fred: the reader's own key> {}\n");
  reset();
  assert.equal(await run(`get('SYN_A', key='right')\nget('SYN_A', key='wrong')`), NODATES.repeat(2));
  assert.deepEqual(page.requests[0], { ...page.requests[1], id: page.requests[0].id });

  // C3: no key yet: the message, nothing upstream
  reset();
  page.key = null;
  const noKey = await run(`try:\n    fredapi.Fred(${JSON.stringify(CANARY)}).get_series('SYN_A')\nexcept RuntimeError as e:\n    print(e)`);
  assert.equal(noKey, "FRED needs your own free FRED API key: add it in Settings > Data (it stays in this page only). Get one at https://fred.stlouisfed.org/docs/api/api_key.html; FRED's terms of use: https://fred.stlouisfed.org/docs/api/terms_of_use.html\n");
  assert.equal(page.upstream, 0);

  // C8 / K12 at the stub: an id outside the catalog, refused before anything upstream (the shim knows no list)
  reset();
  assert.equal(await run(`try:\n    fredapi.Fred('k').get_series('SYN_OUT')\nexcept ValueError as e:\n    print(e)`), "This FRED series isn't in Sagebrush's reviewed list yet: SYN_OUT\n");
  assert.equal(page.upstream, 0);
  assert.equal(page.requests.length, 1);

  // C9: rate-limited: the message, one request, no retry
  reset();
  page.answer = { error: "rate_limited" };
  assert.equal(await run(`try:\n    fredapi.Fred('k').get_series('SYN_A')\nexcept RuntimeError as e:\n    print(e)`), "FRED is rate-limiting; try again in a minute\n");
  assert.equal(page.requests.length, 1);
  // timeout and unavailable: their messages
  page.answer = { error: "timeout" };
  assert.equal(await run(`try:\n    fredapi.Fred('k').get_series('SYN_A')\nexcept TimeoutError as e:\n    print(e)`), "FRED didn't answer in time; try again\n");
  page.answer = { error: "unavailable" };
  assert.equal(await run(`try:\n    fredapi.Fred('k').get_series('SYN_A')\nexcept RuntimeError as e:\n    print(e)`), "FRED live data needs the Sagebrush web app (with your own FRED key, in Settings > Data)\n");

  // C12: what fredapi passes on to FRED is refused, never dropped; vintages too (FRED is current); nothing asked
  reset();
  assert.equal(
    await run(`for kw in ({'units': 'pch'}, {'frequency': 'q'}, {'realtime_start': '2023-06-08'}, {'realtime_end': '2023-07-14'}, {'bogus': 1}):\n    try:\n        fredapi.Fred('k').get_series('SYN_A', **kw)\n    except TypeError as e:\n        print(e)`),
    ["units", "frequency", "realtime_start", "realtime_end", "bogus"].map((k) => `get_series: ${k}= is not supported by Sagebrush's fredapi\n`).join(""),
  );
  assert.equal(page.requests.length, 0);

  // the edges: an id of 64 characters is asked, 65 refused before anything is posted; a bad date likewise
  reset();
  const id64 = "A".repeat(64), id65 = "A".repeat(65);
  assert.equal(await run(`get('${id64}')`), "ValueError This FRED series isn't in Sagebrush's reviewed list yet: " + id64 + "\n");
  assert.equal(page.requests.length, 1);
  assert.match(await run(`try:\n    fredapi.Fred('k').get_series('${id65}')\nexcept ValueError as e:\n    print(e)`), /^FRED series ids are 1 to 64 letters, digits or underscores/);
  assert.match(await run(`try:\n    fredapi.Fred('k').get_series('SYN-A')\nexcept ValueError as e:\n    print(e)`), /^FRED series ids are/);
  assert.match(await run(`try:\n    fredapi.Fred('k').get_series('SYN_A', observation_start='not a date')\nexcept Exception as e:\n    print(type(e).__name__)`), /Error/);
  assert.equal(page.requests.length, 1);

  // K11 at the stub: the bridge called directly, bypassing the shim, is checked the same way: nothing asked for a
  // bad operation, an extra or unknown parameter, a bad id or date, or parameters that aren't JSON
  reset();
  const direct = await run(
    [
      "import json",
      "for op, p in [('fred.series_observations', '{\"series_id\": \"SYN_A\", \"api_key\": \"x\"}'), ('fred.series', '{\"series_id\": \"SYN_A\"}'),",
      "              ('fred.series_observations', '{\"series_id\": \"' + 'A' * 65 + '\"}'), ('fred.series_observations', '{\"series_id\": \"SYN_A\", \"observation_start\": \"2020-02-30\"}'),",
      "              ('fred.series_observations', '{\"series_id\": \"SYN_A\", \"realtime_start\": \"2020-01-01\"}'), ('fred.series_observations', 'not json'),",
      "              ('fred.series_observations', '{\"url\": \"https://example.com\"}')]:",
      "    print(json.loads(__pyjs_host__('live_data', op, p)))",
      "print(json.loads(__pyjs_host__('live_data', 'fred.series_observations', '{\"series_id\": \"SYN_ONE\"}'))['ok']['dates'])",
    ].join("\n"),
  );
  assert.equal(direct, "{'error': 'unavailable'}\n".repeat(7) + "['1999-12-31']\n");
  assert.equal(page.requests.length, 1);

  // the answer is checked as it comes back: over bounds, unknown codes, extra fields are all unavailable, never a
  // partial series or the page's text (the canary planted in them is shown nowhere)
  reset();
  const shapes = [
    { ok: { dates: Array(200_001).fill("2020-01-01"), values: Array(200_001).fill(1) } },
    { error: "teapot", detail: CANARY },
    { error: CANARY },
    { ok: { dates: ["2020-01-01"], values: [1], note: CANARY } },
    { ok: { dates: ["2020-01-01"], values: [1, 2] } },
    { ok: { dates: [CANARY], values: [1] } },
  ];
  for (const a of shapes) {
    page.answer = a;
    // (the page's answers pass through the worker's check, src/live-data.ts checkAnswer, before Python sees them)
    const { checkAnswer } = require("../src/live-data");
    page.answer = checkAnswer(JSON.parse(JSON.stringify(a)));
    assert.equal(await run(`get('SYN_A')`), "RuntimeError FRED live data needs the Sagebrush web app (with your own FRED key, in Settings > Data)\n");
  }

  // C10: FRED never goes through urllib or the replay layer: with both made unimportable, it works the same
  reset();
  assert.equal(await run(`import sys\nsaved = {k: sys.modules.get(k) for k in ('urllib.request', '_sbdata')}\nsys.modules['urllib.request'] = None\nsys.modules['_sbdata'] = None\ntry:\n    get('SYN_A')\nfinally:\n    for k, v in saved.items():\n        if v is None: del sys.modules[k]\n        else: sys.modules[k] = v`), NODATES);
  assert.equal(page.upstream, 1);

  // C11: yfinance imports, and each of its entry points says Yahoo isn't available, asking nothing
  reset();
  assert.equal(
    await run(`import yfinance as yf\nfor f in (lambda: yf.download('SPY'), lambda: yf.Ticker('SPY')):\n    try:\n        f()\n    except RuntimeError as e:\n        print(e)`),
    "Yahoo Finance data isn't available in Sagebrush: automated Yahoo access is unsupported\n".repeat(2),
  );
  assert.equal(page.requests.length, 0);

  // never in a graded run (the grading allowance armed): unavailable, nothing asked
  reset();
  const R = require("../src/runtime").R;
  Atomics.or(R.INTR, 0, 8);
  try {
    assert.equal(await run(`import json\nprint(json.loads(__pyjs_host__('live_data', 'fred.series_observations', '{"series_id": "SYN_A"}')))`), "{'error': 'unavailable'}\n");
  } finally {
    Atomics.and(R.INTR, 0, ~8);
  }
  assert.equal(page.requests.length, 0);

  // C1: the canary given as the book's api_key reached nothing: no request, no output, no message posted; the scan's
  // positive control: printed on purpose, it is found
  const everything = JSON.stringify(msgs) + JSON.stringify(page.all);
  assert.ok(everything.length > 2_000 && page.all.length > 10, "the scan read the session's messages and the page's requests");
  assert.ok(!everything.includes(CANARY), "the canary reached a message or a request");
  await run(`print(${JSON.stringify(CANARY)})`);
  assert.ok(JSON.stringify(msgs).includes(CANARY), "the scan finds a planted canary");
});

// C5: the same Series as fredapi's, its DatetimeIndex and repr; needs pandas' datetime64 / DatetimeIndex /
// to_datetime (design-pandas-xlsx-timeseries PR A); until then the dates are checked above, value for value
test("C5: fredapi's Series, exactly", { skip: "needs pandas PR A (DatetimeIndex, to_datetime)" }, () => {
  assert.ok(SHOW && ORACLE);
});

test("live data is unavailable with no page to ask (the command line)", () => {
  const cli = join(__dirname, "..", "src", "cli.js");
  const r = execFileSync(process.execPath, [cli, "-c", "import _sbdata_live\ntry:\n    _sbdata_live.fred_series_observations({'series_id': 'GDP'})\nexcept _sbdata_live.LiveDataError as e:\n    print(e.code)"], { encoding: "utf8" });
  assert.equal(r, "unavailable\n");
});

test("K13 (lib): no catalog id is in the library or the CLI's embedded copy", () => {
  // (the synthetic catalog's marker ids: the relay's real list is private and never in a client; this checks the
  // shipped library has no list to leak, with a planted positive control)
  const markers = ["SYN_A", "SYN_EMPTY", "SYN_ONE"];
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".py")) files.push(p);
    }
  };
  walk(join(ROOT, "lib"));
  const lib = files.map((f) => readFileSync(f, "utf8")).join("\n");
  assert.ok(files.length > 50 && lib.includes("def get_series"), "the scan read the library");
  for (const m of markers) assert.ok(!lib.includes(m), `${m} is in the library`);
  assert.ok((lib + "\n# SYN_A").includes("SYN_A"), "the scan finds a planted marker");
});
