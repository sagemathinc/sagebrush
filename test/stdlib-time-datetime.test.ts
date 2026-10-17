import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// time (lib/_pytime.py over the _time builtin) and datetime (CPython 3.14's
// datetime.py, and _pydatetime.py with the C module's messages and reprs),
// compared with CPython 3.14 on glibc (S2 of the stdlib the curated PyPI
// packages need). Each case file runs under the same TZ on both sides; on a
// zone other than UTC or GMT, what is not known here is refused, checked
// apart from CPython.
const TEST = __dirname + "/../../test/";
const run = (cmd: string, args: string[], tz: string, more: Record<string, string> = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TZ: tz, ...more }, maxBuffer: 64 << 20 }).split("\n");
const sagebrush = (file: string, tz: string, more: Record<string, string> = {}) => run(process.execPath, [__dirname + "/../src/cli.js", TEST + file], tz, more);
const cpython = (file: string, tz: string, more: Record<string, string> = {}) => run("python3", [TEST + file], tz, more);
function same(file: string, tz: string) {
  const want = cpython(file, tz), got = sagebrush(file, tz);
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${file} under TZ=${tz}, line ${i + 1}`);
}

for (const file of ["time_cases.py", "strftime_cases.py", "datetime_cases.py", "datetime_c_cases.py", "time_payload_cases.py"])
  test(`${file}: CPython's output under TZ=UTC`, () => same(file, "UTC"));

// (on any host zone, as glibc reads it (lib/_tzrules.py): the local times,
// tm_isdst and tm_zone, tzname, timezone, altzone and daylight, mktime with
// its kept offset, %Z of a tuple with no zone; zones with daylight saving
// north and south, Dublin's negative daylight saving, Lord_Howe's half hour,
// Kolkata's none, Troll's two hours, Apia's skipped day, Casablanca's
// Ramadan, TZ rules)
const ZONES = ["UTC", "Etc/GMT", "America/New_York", "Europe/Berlin", "Europe/Dublin", "Australia/Lord_Howe", "Asia/Kolkata", "Australia/Sydney"];
for (const tz of ZONES)
  test(`time_zone_cases.py: CPython's output under TZ=${tz}`, () => same("time_zone_cases.py", tz));
for (const tz of ["UTC", "Europe/Berlin", "America/New_York", "Europe/Dublin", "Australia/Lord_Howe"])
  test(`time_local_cases.py under TZ=${tz}: CPython's output, but tzset and strptime refuse`, () => {
    const want = cpython("time_local_cases.py", tz), got = sagebrush("time_local_cases.py", tz);
    const refused = /^(tzset|strptime|datetime strptime) /;
    assert.deepEqual(got.filter((l) => !refused.test(l)), want.filter((l) => !refused.test(l)));
    const lines = got.filter((l) => refused.test(l));
    assert.deepEqual(lines.map((l) => l.replace(/ raises NotImplementedError .*/, "")), ["tzset", "strptime", "datetime strptime"]);
  });
for (const tz of ["America/New_York", "Europe/Dublin", "Australia/Lord_Howe", "Antarctica/Troll", "Pacific/Apia", "Africa/Casablanca", "Asia/Kolkata",
  "EST5EDT,M3.2.0,M11.1.0", "IST-1GMT0,M10.5.0,M3.5.0/1", "<+1030>-10:30<+11>-11,M10.1.0,M4.1.0", "CEX0<-0330>-2,48/+25,M1.1.2/-1", "MCN-5JRKA,M11.3.1,M11.3.2"])
  test(`time_zone_sweep_cases.py: CPython's output under TZ=${tz}`, () => same("time_zone_sweep_cases.py", tz));

// (in a browser, which has no zone files (until the pinned zone data comes):
// S2's way, unchanged, run under Node as a browser. UTC: all as CPython's but
// for tzset and strptime, which refuse here)
const NO_FILES = { SAGEBRUSH_TIME_NO_ZONE_FILES: "1" };
test("as a browser, time_jsdate_cases.py under TZ=UTC: CPython's output, but tzset and strptime refuse", () => {
  const want = cpython("time_jsdate_cases.py", "UTC"), got = sagebrush("time_jsdate_cases.py", "UTC", NO_FILES);
  const refused = /^(tzset|strptime|datetime strptime) /;
  assert.deepEqual(got.filter((l) => !refused.test(l)), want.filter((l) => !refused.test(l)));
  const lines = got.filter((l) => refused.test(l));
  assert.deepEqual(lines.map((l) => l.replace(/ raises NotImplementedError .*/, "")), ["tzset", "strptime", "datetime strptime"]);
});

// (on another zone: tm_isdst a placeholder refused on any use but repr and
// str, tm_zone, tzname and %Z refused, mktime refusing isdst 0 or 1 and a
// skipped or repeated time, tzname out of dir() and import-star; each a
// NotImplementedError naming the zone; the rest working)
test("as a browser, time_jsdate_cases.py under TZ=Europe/Berlin: each refusal names the zone, the rest works", () => {
  const out = sagebrush("time_jsdate_cases.py", "Europe/Berlin", NO_FILES);
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

// (glibc's tzname after a failed mktime: refused in Sagebrush until a local
// time sets it again; the failure itself and the rest as CPython's)
test("time_tzname_after_failure_case.py under TZ=Australia/Lord_Howe: %Z refuses right after the failed mktime", () => {
  const want = cpython("time_tzname_after_failure_case.py", "Australia/Lord_Howe"), got = sagebrush("time_tzname_after_failure_case.py", "Australia/Lord_Howe");
  assert.equal(got[0], want[0]);
  assert.equal(want[0], "mktime OverflowError mktime argument out of range");
  assert.match(got[1], /^right after raises NotImplementedError time\.strftime\(\): %Z of a time tuple with no zone/);
  assert.equal(got[2], want[2]);
});

// (TZ in its forms, glibc's readings of odd ones included: a rule, a path,
// with and without ":", a name with no file (read as a rule: "Foo"), an empty
// TZ, a TZDIR, which holds anything (astra's files: New York's name with
// UTC's data, UTC's name with New York's), written out as the system's or not)
for (const tz of [":America/New_York", "America/New_York", "EST5EDT,M3.2.0/2,M11.1.0/2", "/usr/share/zoneinfo/America/New_York",
  ":/usr/share/zoneinfo/America/New_York", "UTC+05", "", "Foo/Bar", ":", "XYZ", "<+05>-5", "ABC25"])
  test(`time_tz_forms_cases.py: CPython's output under TZ=${JSON.stringify(tz)}`, () => same("time_tz_forms_cases.py", tz));
test("time_tz_forms_cases.py under a TZDIR of its own: CPython's output", () => {
  const dir = mkdtempSync(tmpdir() + "/sagebrush-tzdir-");
  try {
    mkdirSync(dir + "/America");
    copyFileSync("/usr/share/zoneinfo/Etc/UTC", dir + "/America/New_York");
    copyFileSync("/usr/share/zoneinfo/America/New_York", dir + "/UTC");
    for (const tz of ["America/New_York", "UTC", "Etc/GMT", "", "Missing/Zone"])
      assert.deepEqual(sagebrush("time_tz_forms_cases.py", tz, { TZDIR: dir }), cpython("time_tz_forms_cases.py", tz, { TZDIR: dir }), tz);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
for (const tzdir of ["/usr/share/zoneinfo", "/usr/share/zoneinfo/", ""])
  test(`time_tz_forms_cases.py under TZ=America/New_York, TZDIR=${JSON.stringify(tzdir)}: CPython's output`, () => {
    assert.deepEqual(sagebrush("time_tz_forms_cases.py", "America/New_York", { TZDIR: tzdir }), cpython("time_tz_forms_cases.py", "America/New_York", { TZDIR: tzdir }));
  });

// (TZ values glibc reads in ways not matched here: refused, naming them,
// every local time; UTC and the rest as CPython's)
const LOCAL = /^(localtime|ctime|fromtimestamp|date\.fromtimestamp|timezone|altzone|daylight|mktime|timestamp|now type|localtime type) /;
for (const tz of ["ABC5DEF", "ABC5DEF,M3.2.0", "EST5EDT,M13.1.0,M11.1.0", "ABC5 ", "ABC5DEF,M3.2.0,M11.1.0x"])
  test(`time_tz_forms_cases.py under TZ=${JSON.stringify(tz)}: local times refuse, naming TZ; the rest as CPython's`, () => {
    const want = cpython("time_tz_forms_cases.py", tz), got = sagebrush("time_tz_forms_cases.py", tz);
    assert.deepEqual(got.filter((l) => !LOCAL.test(l)), want.filter((l) => !LOCAL.test(l)));
    const local = got.filter((l) => LOCAL.test(l));
    assert.equal(local.length, 19);
    for (const l of local) assert.ok(l.includes(" raises NotImplementedError time: the host's time zone (TZ=" + JSON.stringify(tz).replace(/"/g, "'") + ")"), l);
  });
