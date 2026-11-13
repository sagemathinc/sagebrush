// ci: unit order=168 runner=bun
// A check build's ?agent=<kind> (dev-agent-kind.ts): only a kind's name (the runner's own pattern) is taken, anything
// else is none; the picker's word for it before connecting.
import { devAgentKind, kindLabel } from "./dev-agent-kind.ts";

let failures = 0;
const ok = (c, what, got) => { if (c) console.log(`ok   ${what}`); else { failures++; console.log(`FAIL ${what}${got === undefined ? "" : ` (got ${JSON.stringify(got)})`}`); } };
for (const [search, want] of [["?agent=codex", "codex"], ["?agent=claude", "claude"], ["?x=1&agent=my-agent2", "my-agent2"], ["?agent=a" + "b".repeat(15), "a" + "b".repeat(15)]]) ok(devAgentKind(search) === want, `${search}: ${want}`, devAgentKind(search));
for (const search of ["", "?agent=", "?agent=Codex", "?agent=codex%20x", "?agent=1codex", "?agent=-x", "?agent=a" + "b".repeat(16), "?agent=codex%0A", "?agent=..%2Fx", "?other=codex"]) ok(devAgentKind(search) === undefined, `${JSON.stringify(search)}: none`, devAgentKind(search));
ok(kindLabel(undefined) === "Claude" && kindLabel("claude") === "Claude" && kindLabel("codex") === "Codex" && kindLabel("my-agent") === "my-agent", "the picker's words: Claude, Codex, else the kind");
console.log(failures ? `test-dev-agent-kind: ${failures} failed` : "test-dev-agent-kind: all passed");
process.exit(failures ? 1 : 0);
