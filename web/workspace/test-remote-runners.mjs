// ci: web-runner order=596 runner=bun
// Your computers as the pages list them (remote-runners.ts): the peer list's runners, each with the agent kinds it last
// reported, taken only as a list of at most 4 unique names of the runner's own pattern (else none), and its time only
// with such a list, a non-negative whole number of ms.
//   bun web/workspace/test-remote-runners.mjs
import { listRunners, runnerAgents } from "./remote-runners.ts";

let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const answer = (body, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const peer = (o) => ({ remote_id: "rAAAAAAAAAAAAAAAAAAAA", kind: "runner", name: "s1-cocalc", ...o });

{
  const rs = await listRunners(answer({ peers: [peer({ agents: ["claude", "codex"], agents_at: 1794558000000 }), peer({ remote_id: "rB", kind: "agent", agents: ["claude"] }), peer({ remote_id: "rC" })], available: true }));
  ok(rs.length === 2 && rs[0].name === "s1-cocalc" && JSON.stringify(rs[0].agents) === '["claude","codex"]' && rs[0].agents_at === 1794558000000,
    "a runner's kinds, in its order, with their time (an agent's key isn't a runner, so not listed)");
  ok(JSON.stringify(rs[1].agents) === "[]" && rs[1].agents_at === null, "a runner from before the kinds were reported: [] and null");
}
for (const [agents, what] of [[["Claude"], "an upper-case name"], [["a", "a"], "a name twice"], [["a", "b", "c", "d", "e"], "five names"],
  [["a".repeat(17)], "17 characters"], [[1], "a number"], ["claude", "a string, not a list"], [{ 0: "claude" }, "an object"],
  [["<b>x</b>"], "markup"], [null, "null"]]) {
  const r = runnerAgents({ agents, agents_at: 5 });
  ok(JSON.stringify(r.agents) === "[]" && r.agents_at === null, `${what}: no kinds and no time (${JSON.stringify(r)})`);
}
for (const [at, what] of [[-1, "a negative time"], [1.5, "a fractional time"], ["5", "a string time"], [2 ** 53, "an unsafe time"], [undefined, "no time"]]) {
  const r = runnerAgents({ agents: ["claude"], agents_at: at });
  ok(JSON.stringify(r.agents) === '["claude"]' && r.agents_at === null, `${what}: the kinds, with no time (${JSON.stringify(r)})`);
}
{
  const four = ["a", "b", "c", "d"].map((c) => c.repeat(16));
  const r = runnerAgents({ agents: four, agents_at: 0 });
  ok(JSON.stringify(r.agents) === JSON.stringify(four) && r.agents_at === 0, "four names of 16 characters, and time 0, are taken");
  const src = ["claude"];
  const t = runnerAgents({ agents: src });
  src.push("x");
  ok(JSON.stringify(t.agents) === '["claude"]', "the list is the page's own copy");
}

if (failures) { console.log(`test-remote-runners: ${failures} failed`); process.exit(1); }
console.log("test-remote-runners: all passed");
