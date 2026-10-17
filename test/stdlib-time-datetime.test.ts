import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// time (lib/_pytime.py over the _time builtin) and datetime (CPython 3.14's
// datetime.py, and _pydatetime.py with the C module's messages and reprs),
// compared with CPython 3.14 on glibc (S2 of the stdlib the curated PyPI
// packages need). Each case file runs under the same TZ on both sides; on a
// zone other than UTC or GMT, what is not known here is refused, checked
// apart from CPython.
const TEST = __dirname + "/../../test/";
const run = (cmd: string, args: string[], tz: string) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TZ: tz }, maxBuffer: 64 << 20 }).split("\n");
const sagebrush = (file: string, tz: string) => run(process.execPath, [__dirname + "/../src/cli.js", TEST + file], tz);
const cpython = (file: string, tz: string) => run("python3", [TEST + file], tz);
function same(file: string, tz: string) {
  const want = cpython(file, tz), got = sagebrush(file, tz);
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${file} under TZ=${tz}, line ${i + 1}`);
}

for (const file of ["time_cases.py", "strftime_cases.py", "datetime_cases.py", "datetime_c_cases.py"])
  test(`${file}: CPython's output under TZ=UTC`, () => same(file, "UTC"));

// (exact on any host: the offsets, so localtime()'s fields and tm_gmtoff,
// timezone, altzone and daylight, mktime away from a transition, datetime's
// fromtimestamp and timestamp; the zones: a northern and a southern one with
// daylight saving, Dublin's negative daylight saving, Lord_Howe's half
// hour, Kolkata's none)
for (const tz of ["UTC", "Etc/GMT", "America/New_York", "Europe/Berlin", "Europe/Dublin", "Australia/Lord_Howe", "Asia/Kolkata", "Australia/Sydney"])
  test(`time_zone_cases.py: CPython's output under TZ=${tz}`, () => same("time_zone_cases.py", tz));

// (on a UTC host, all as CPython's but for tzset and strptime, which refuse here)
test("time_refusals_cases.py under TZ=UTC: CPython's output, but tzset and strptime refuse", () => {
  const want = cpython("time_refusals_cases.py", "UTC"), got = sagebrush("time_refusals_cases.py", "UTC");
  const refused = /^(tzset|strptime|datetime strptime) /;
  assert.deepEqual(got.filter((l) => !refused.test(l)), want.filter((l) => !refused.test(l)));
  const lines = got.filter((l) => refused.test(l));
  assert.deepEqual(lines.map((l) => l.replace(/ raises NotImplementedError .*/, "")), ["tzset", "strptime", "datetime strptime"]);
});

// (on another zone: tm_isdst a placeholder refused on any use but repr and
// str, tm_zone, tzname and %Z refused, mktime refusing isdst 0 or 1 and a
// skipped or repeated time, tzname out of dir() and import-star; each a
// NotImplementedError naming the zone; the rest working)
test("time_refusals_cases.py under TZ=Europe/Berlin: each refusal names the zone, the rest works", () => {
  const out = sagebrush("time_refusals_cases.py", "Europe/Berlin");
  const line = (label: string) => out.find((l) => l.startsWith(label + " ")) ?? `(no ${label})`;
  assert.equal(line("repr"), "repr -> time.struct_time(tm_year=1970, tm_mon=1, tm_mday=1, tm_hour=1, tm_min=0, tm_sec=0, tm_wday=3, tm_yday=1, tm_isdst=<unknown: Europe/Berlin>)");
  assert.equal(line("fields"), "fields -> ((1970, 1, 1, 1, 0, 0, 3, 1), 3600)");
  assert.equal(line("unpacked, indexed"), "unpacked, indexed -> (1970, 1, '<unknown: Europe/Berlin>')");
  assert.equal(line("str of isdst"), "str of isdst -> <unknown: Europe/Berlin>");
  for (const label of ["isdst == 0", "bool", "int", "hash", "format", "f-string", "arithmetic", "struct == struct", "struct hash", "struct <", "pickle", "copy", "strftime %s", "mktime struct"])
    assert.match(line(label), /raises NotImplementedError tm_isdst is not known for the host's time zone Europe\/Berlin here/, label);
  for (const [label, what] of [["tm_zone", "tm_zone"], ["tzname", "tzname"], ["hasattr tzname", "tzname"], ["strftime %Z", "%Z"], ["strftime %Z now", "%Z"], ["strftime %Z tuple", "%Z"], ["naive astimezone", "tm_zone"], ["astimezone no argument", "tm_zone"]])
    assert.match(line(label), new RegExp(`raises NotImplementedError ${what} is not known for the host's time zone Europe/Berlin here`), label);
  assert.match(line("mktime isdst 0"), /raises NotImplementedError mktime\(\) with tm_isdst 0 is not known for the host's time zone Europe\/Berlin/);
  assert.match(line("mktime isdst 1"), /raises NotImplementedError mktime\(\) with tm_isdst 1 is not known/);
  assert.match(line("mktime skipped"), /raises NotImplementedError time\.mktime\(\): 2020-03-29 02:30:00 is skipped in the host's time zone Europe\/Berlin/);
  assert.match(line("mktime repeated"), /raises NotImplementedError time\.mktime\(\): 2020-10-25 02:30:00 is repeated in the host's time zone Europe\/Berlin/);
  assert.match(line("beyond JS dates"), /raises NotImplementedError time: the host's time zone Europe\/Berlin is known here only within JavaScript's dates/);
  assert.match(line("tzset"), /raises NotImplementedError time\.tzset\(\)/);
  assert.match(line("strptime"), /raises NotImplementedError strptime needs CPython's _strptime, which needs the calendar module/);
  assert.match(line("datetime strptime"), /raises NotImplementedError strptime needs CPython's _strptime/);
  assert.equal(line("mktime plain"), "mktime plain -> 1577876400.0");
  assert.equal(line("strftime %Y %z"), "strftime %Y %z -> 1970 +0100");
  assert.equal(line("asctime"), "asctime -> Thu Jan  1 01:00:00 1970");
  assert.equal(line("datetime fromtimestamp"), "datetime fromtimestamp -> 1970-01-01 01:00:00");
  assert.equal(line("import-star has tzname:"), "import-star has tzname: False dir has tzname: False");
  assert.equal(line("gmtime zone:"), "gmtime zone: GMT 0");
});
