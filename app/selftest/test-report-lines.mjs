// report-lines.mjs on a desktop app's output with the diagnosis lines: they
// are kept (CRLF or not), other output is dropped, and run.mjs's verdict
// (exit code 0 and "all passed") is unaffected by them.
//   node app/selftest/test-report-lines.mjs
import { readFileSync } from "node:fs";
import { reportLines } from "./report-lines.mjs";

const here = new URL(".", import.meta.url);
let bad = 0;
const check = (name, cond, detail = "") => { console.log((cond ? "ok   " : "FAIL ") + name + (detail ? ": " + detail : "")); if (!cond) bad = 1; };
for (const f of ["good", "coi-fail"]) {
  const report = readFileSync(new URL(`report-fixtures/${f}.txt`, here), "utf8").trimEnd().split("\n");
  const noisy = ["[app] the page is at http://127.0.0.1:1/", ...report, "[page] start x", ""].join("\n");
  for (const [label, text] of [["LF", noisy], ["CRLF", noisy.replaceAll("\n", "\r\n")]]) {
    const got = reportLines(text);
    check(`${f} (${label}): the report's lines, in order, nothing else`, JSON.stringify(got) === JSON.stringify(report), `${got.length} lines, ${report.length} expected`);
    check(`${f} (${label}): it has the 12 info lines`, got.filter((l) => l.startsWith("info ")).length === 12);
  }
  const passed = report.includes("all passed");
  check(`${f}: the verdict comes from "all passed" only`, passed === (f === "good"));
}
if (bad) { console.log("FAIL: report-lines.mjs"); process.exit(1); }
console.log("ok: report-lines.mjs keeps the report's lines, info included, and only them");
