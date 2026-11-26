#!/usr/bin/env node
// Report-only advice for the independent LaTeX bundle caps.
import { appendFileSync } from "node:fs";

export const ADVICE_SLACK = 64;

const integer = (n) => Number.isSafeInteger(n);
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const cell = (s) => String(s).replaceAll("|", "\\|").replaceAll("\n", " ");

export function markerAdvice(measured, current) {
  if (!integer(measured) || !integer(current)) throw new Error("size advice needs safe integer measurements and markers");
  const target = measured + ADVICE_SLACK;
  if (!integer(target)) throw new Error("size advice target leaves the safe-integer range");
  const verdict = current < measured ? "RAISE" : current > target ? "TIGHTEN" : "KEEP";
  return { measured, current, suggested: verdict === "KEEP" ? null : target, verdict };
}

export function adviceTable(title, rows, {
  deltaHeading = "measured Δ",
  currentHeading = "current marker",
  targetHeading = "suggested target (measured + 64 B)",
} = {}) {
  const lines = [`## ${title}`, ""];
  if (!rows.length) return [...lines, "No eligible row has growth needing a marker.", ""];
  lines.push(`| bundle | ${deltaHeading} | ${currentHeading} | ${targetHeading} | target-relative verdict |`, "|---|---:|---:|---:|---|");
  for (const row of rows) {
    const a = markerAdvice(row.measured, row.current);
    lines.push(`| ${cell(row.bundle)} | ${signed(row.delta ?? a.measured)} | ${a.current} | ${a.suggested ?? "—"} | **${a.verdict}** |`);
  }
  lines.push("", `When a change is needed, the suggested target is the measurement plus ${ADVICE_SLACK} B. RAISE/KEEP/TIGHTEN compare the current value with the interval from the measurement through that target. A current value exactly equal to the measurement is accepted by the size rule and gets KEEP. KEEP means leave the current value unchanged—never refill slack. The verdicts are advice, not pass/fail, and do not approve a marker or cap raise. The existing gate remains authoritative.`, "");
  return lines;
}

export function latexAdvice(group, lazy) {
  const rows = [];
  const add = (bundle, measured, cap) => {
    if (!integer(measured) || !integer(cap)) return;
    // LaTeX caps are renewed to landing measurement + 64. Therefore cap-64
    // is the measurement represented by the current cap, and this delta is
    // the growth (or shrink) since that represented measurement.
    rows.push({ bundle, measured, delta: measured - (cap - ADVICE_SLACK), current: cap });
  };
  add("LaTeX eager group (raw)", group?.raw, group?.cap?.raw);
  add("LaTeX eager group (gzip)", group?.gzip, group?.cap?.gzip);
  for (const chunk of lazy ?? []) {
    if (!chunk.present) continue;
    add(`${chunk.label} (raw)`, chunk.raw, chunk.cap.raw);
    add(`${chunk.label} (gzip)`, chunk.gzip, chunk.cap.gzip);
  }
  return adviceTable("LaTeX bundle-cap advice", rows, {
    deltaHeading: "measured Δ from current cap − 64 B",
    currentHeading: "current cap",
    targetHeading: "suggested cap (measured + 64 B)",
  });
}

export function appendPullRequestSummary(lines, env = process.env) {
  if (env.GITHUB_EVENT_NAME !== "pull_request" || !env.GITHUB_STEP_SUMMARY) return false;
  appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  return true;
}

export function safelyAppendPullRequestSummary(makeLines, env = process.env) {
  try {
    const lines = typeof makeLines === "function" ? makeLines() : makeLines;
    return appendPullRequestSummary(lines, env);
  } catch (e) {
    console.warn(`size advice was not written (the authoritative gate result is unchanged): ${e?.message ?? e}`);
    return false;
  }
}
