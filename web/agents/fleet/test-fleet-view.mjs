// The fleet pages' view model (web/agents/fleet/view.ts; design agent-autonomous-pages-fleet r2.1 §1.3, §2.1, §4):
// unverified reports are closed enums or "unknown", missing or stale is unknown and never healthy, and only verified
// facts decide "applied". With SAGEBRUSH_AGENT_DIR, the page's closed lists are compared with the producer's own files.
//   bun web/agents/fleet/test-fleet-view.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as V from "./view.ts";

let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };
const HOST = "abcdefghijklmnopqrstuvwxya", A1 = "bbcdefghijklmnopqrstuvwxya", A2 = "cbcdefghijklmnopqrstuvwxya";
const NOW = 1_800_000_000_000;
const report = (over = {}, agents = {}) => ({ host: { reported_at_ms: NOW - 2000, last_seen_ms: NOW - 1000, health: "ok", health_reasons: [], ...over }, agents });
const agent = (over = {}) => ({ run: "running", fences: [], lease: "live", lease_expires_at_ms: NOW + 600_000, restore: null, ...over });

// ---- a fresh, well-formed report reads as sent
{
  const r = V.readHostReport(report({}, { [A1]: agent() }), HOST, NOW);
  ok(r.kind === "report" && r.source === HOST && r.age === 1000 && !r.stale && V.healthShown(r) === "ok", "a fresh report: its source host, its age (from the service's last_seen_ms), health ok", r);
  const a = V.agentShown(r, A1);
  ok(a?.run === "running" && a.lease === "live" && a.leaseEnds === NOW + 600_000 && !a.leaseLapsed && a.restore === null && a.fences.length === 0, "an agent's line: run, lease and its end, no restore record", a);
}
// ---- missing, malformed and stale reports are unknown, never healthy
for (const [raw, what] of [[null, "no answer"], [undefined, "undefined"], ["ok", "a string"], [[], "an array"], [42, "a number"]]) {
  const r = V.readHostReport(raw, HOST, NOW);
  ok(r.kind === "none" && V.healthShown(r) === "unknown", `${what}: nothing to show ("${V.TEXT.notReported}"), health unknown`, r);
}
{
  const r = V.readHostReport(report({ last_seen_ms: NOW - V.STALE_MS - 1 }), HOST, NOW);
  ok(r.kind === "report" && r.stale && V.healthShown(r) === "unknown", "older than 30 s: stale, and its ok health shows unknown", r);
  const edge = V.readHostReport(report({ last_seen_ms: NOW - V.STALE_MS }), HOST, NOW);
  ok(edge.kind === "report" && !edge.stale, "exactly 30 s old: not yet stale (the bound is inclusive)");
  for (const [v, what] of [[undefined, "no last_seen_ms"], ["123", "a string time"], [0, "time 0"], [-5, "a negative time"], [1.5, "a fractional time"]]) {
    const x = V.readHostReport(report({ last_seen_ms: v }), HOST, NOW);
    ok(x.kind === "report" && x.stale && x.age === null && V.healthShown(x) === "unknown", `${what}: no age, so stale, health unknown`);
  }
  const host = V.readHostReport(report({ reported_at_ms: NOW, last_seen_ms: undefined }), HOST, NOW);
  ok(host.kind === "report" && host.stale, "the host's own reported_at_ms never stands for last_seen_ms (the service's time decides)");
  const sA = V.agentShown(V.readHostReport(report({ last_seen_ms: NOW - 60_000 }, { [A1]: agent({ restore: "validated" }) }), HOST, NOW), A1);
  ok(sA?.run === "unknown" && sA.lease === "unknown" && sA.fences.join() === "unknown" && sA.restore === "unknown", "a stale report's agent: every field unknown", sA);
}
// ---- closed enums: anything else is "unknown", field by field
{
  const r = V.readHostReport(report({ health: "great", health_reasons: ["clone_detected", "<b>x</b>", 7] }, { [A1]: agent({ run: "flying", fences: ["lease", "lease", "nope"], lease: "maybe", restore: "done" }) }), HOST, NOW);
  ok(r.kind === "report" && r.health === "unknown" && JSON.stringify(r.reasons) === '["clone_detected","unknown","unknown"]', "health and reasons outside their lists: unknown", r.kind === "report" && [r.health, r.reasons]);
  const a = V.agentShown(r, A1);
  ok(a?.run === "unknown" && JSON.stringify(a.fences) === '["lease","unknown"]' && a.lease === "unknown" && a.restore === "unknown", "run, fences (deduplicated), lease and restore outside their lists: unknown", a);
  const bad = V.readHostReport(report({}, { [A1]: agent({ fences: "lease" }), "not-an-id": agent(), [A2]: "running" }), HOST, NOW);
  ok(bad.kind === "report" && JSON.stringify(V.agentShown(bad, A1)?.fences) === '["unknown"]' && !bad.agents.has("not-an-id") && !bad.agents.has(A2), "fences not a list: unknown; a malformed agent id or entry: not shown");
}
// ---- the lease: its end is approximate, and a passed end is said
{
  const a = V.agentShown(V.readHostReport(report({}, { [A1]: agent({ lease_expires_at_ms: NOW - 1 }) }), HOST, NOW), A1);
  ok(a?.leaseLapsed === true, "a lease end already passed by this page's clock: lapsed");
}
// ---- restore, in the page's words, read with run (r2.1 §2.1)
{
  const W = V.TEXT.restore;
  const rows = [
    [null, "running", null], ["staging", "stopped", W.restoring], ["staged", "stopped", W.restoring], ["filling", "stopped", W.restoring],
    ["published", "stopped", W.checking], ["validated", "stopped", W.waiting], ["validated", "provisioned", W.waiting], ["validated", "paused", W.waiting],
    ["validated", "running", W.resumed], ["validated", "unknown", "unknown"], ["not_fitting", "stopped", W.notFitting], ["failed", "running", W.failed], ["unknown", "running", "unknown"],
  ];
  const bad = rows.filter(([r, run, want]) => V.restoreWords(r, run) !== want);
  ok(bad.length === 0, `restore words: all ${rows.length} rows of the table (validated is "waiting to resume" unless run says running; unknown run, unknown)`, bad);
  ok(V.FENCES.every((f) => typeof V.fenceWords(f) === "string" && V.fenceWords(f).length > 0) && V.fenceWords("unknown") === "unknown", "every fence has its words; an unknown fence says unknown");
}
// ---- "applied" only from verified facts
{
  ok(V.grantState(null, null, false) === "none" && V.grantState(3, null, false) === "waiting" && V.grantState(3, 2, false) === "waiting" && V.grantState(3, 3, false) === "applied" && V.grantState(3, null, true) === "narrowing", "grant state: none, waiting (no ack, or an older one), applied (a verified ack for this gen), narrowing");
  ok(V.grantState.length === 3, "grantState takes only the verified grant gen, the verified ack gen and narrowing: no report reaches it");
  const src = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export function grantState"), src.indexOf("\n}\n", src.indexOf("export function grantState")));
  ok(!/report|health|Report/i.test(body.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/No report is an input/, "")), "grantState's code mentions no report or health");
}
// ---- free text: bounded, plain
{
  const long = "x".repeat(500), emoji = "😀".repeat(250);
  ok(V.bounded(long).length === V.TEXT_MAX && V.bounded(long).endsWith("…") && Array.from(V.bounded(emoji)).length === V.TEXT_MAX && V.bounded("<b>hi</b>") === "<b>hi</b>" && V.bounded(7) === "", "bounded: at most 200 characters by code point, a non-string empty, markup kept as text (the page sets textContent)");
}
// ---- late answers are dropped
{
  const f = V.freshness();
  const t1 = f.take({ account: "a", fleet: "f", host: "h1" });
  ok(f.current(t1), "the newest load's answer is drawn");
  const t2 = f.take({ account: "a", fleet: "f", host: "h2" });
  ok(!f.current(t1) && f.current(t2), "after a switch to another host, the earlier answer is dropped");
  const t3 = f.take({ account: "b", fleet: "f", host: "h2" });
  ok(!f.current(t2) && f.current(t3), "after a switch of account, the earlier answer is dropped");
}
ok(V.ago(0) === "just now" && V.ago(40_000) === "40 s ago" && V.ago(180_000) === "3 min ago" && V.ago(7_200_000) === "2 h ago" && V.ago(5 * 86_400_000) === "5 days ago" && V.ago(NaN) === "unknown", "ages in words");
ok(V.lifetime(null, NOW) === "no expiry" && V.lifetime(NOW - 1, NOW) === "expired" && V.lifetime(NOW + 3 * 86_400_000, NOW) === "expires in 3 days" && V.lifetime(NOW + 5 * 3_600_000, NOW) === "expires in 5 h", "grant lifetimes in words");

// ---- the page's closed lists are the producer's (with the agent's repository)
if (process.env.SAGEBRUSH_AGENT_DIR) {
  const show = (p) => execFileSync("git", ["-C", process.env.SAGEBRUSH_AGENT_DIR, "show", `origin/HEAD:${p}`], { encoding: "utf8" });
  const list = (src, re) => JSON.parse("[" + src.match(re)[1] + "]");
  const hs = show("lib/fleet/host/host-state.mjs");
  const health = [...new Set(Object.values(JSON.parse(hs.match(/export const HEALTH = Object\.freeze\((\{[^}]*\})\)/)[1].replace(/(\w+):/g, '"$1":'))))];
  const lists = {
    health: [health, V.HEALTH],
    reasons: [list(hs, /export const HEALTH_REASONS = Object\.freeze\(\[([^\]]*)\]\)/), V.HEALTH_REASONS],
    run: [list(show("lib/fleet/host/registry.mjs"), /export const STATES = Object\.freeze\(\[([^\]]*)\]\)/), V.RUN_STATES],
    fences: [[...list(show("lib/fleet/host/fence.mjs"), /export const CAUSES = Object\.freeze\(\[([^\]]*)\]\)/).filter((x) => x !== "transferred"), "transferred"], V.FENCES],
    restore: [list(show("lib/fleet/host/restore-record.mjs"), /export const STATES = Object\.freeze\(\[([^\]]*)\]\)/), V.RESTORE_STATES],
  };
  const differ = Object.entries(lists).filter(([, [theirs, mine]]) => JSON.stringify([...theirs].sort()) !== JSON.stringify([...mine].sort())).map(([k, [t, m]]) => ({ k, theirs: t, mine: m }));
  ok(differ.length === 0, "the page's closed lists equal the producer's (health, reasons, run, fences + transferred, restore) on the agent's main", differ);
} else console.log("skip: the producer's lists (no SAGEBRUSH_AGENT_DIR)");

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
