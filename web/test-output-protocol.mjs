// ci: web-runner order=124 runner=bun
// The output frames' message schema (web/output-shell/protocol.js), without a browser: what decode() refuses,
// each on its own, beside a valid control that it accepts.  The browser harness (web/test-output-frames.mjs)
// shows the host and the shell act on decode()'s answer; this pins the answer itself.
//   bun web/test-output-protocol.mjs
import { LIMITS, decode, encode } from "./output-shell/protocol.js";

let failures = 0, checks = 0;
const ok = (c, msg) => { checks++; console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const s = (o) => JSON.stringify(o);
const committed = { v: 1, type: "committed", generation: 3, area: "a1", ids: ["o1", "o2"], height: 40 };
const render = { v: 1, type: "render", generation: 3, area: "a1", outputs: [{ id: "o1", kind: "text", body: "x" }] };

// (the controls: the same messages, valid)
ok(decode("to-host", s(committed))?.height === 40, "a valid committed message decodes");
ok(decode("to-frame", s(render))?.outputs.length === 1, "a valid render message decodes");
ok(decode("to-frame", encode("to-frame", "render", { generation: 3, area: "a1", outputs: render.outputs })) !== null, "what encode() writes, decode() reads");

// (an oversized message: refused by its length, before JSON.parse ever sees it; otherwise valid)
const big = s({ ...render, outputs: [{ id: "o1", kind: "text", body: "x".repeat(LIMITS.messageChars) }] });
let parsed = 0;
const parse = JSON.parse;
JSON.parse = (...a) => { parsed++; return parse(...a); };
const bigOut = decode("to-frame", big);
JSON.parse = parse;
ok(big.length > LIMITS.messageChars && bigOut === null && parsed === 0, `a message over ${LIMITS.messageChars} characters is refused before it is parsed: ${parsed} parse(s)`);
const atCap = s({ ...render, outputs: [{ id: "o1", kind: "text", body: "x".repeat(LIMITS.messageChars - s(render).length + 1) }] });
ok(atCap.length === LIMITS.messageChars && decode("to-frame", atCap) !== null, "one exactly at the cap is accepted");

// (each field rule on its own)
const { height: _h, ...noHeight } = committed;
ok(decode("to-host", s(noHeight)) === null, "a committed message missing a field (height) is refused");
ok(decode("to-host", s({ ...committed, extra: 1 })) === null, "one with an unknown field is refused");
ok(decode("to-host", s({ ...committed, v: 2 })) === null && decode("to-host", s({ ...committed, v: undefined })) === null, "another schema version, or none, is refused");
ok(decode("to-host", s({ ...committed, ids: ["o1", "o1"] })) === null, "a commit naming one output twice is refused");
ok(decode("to-frame", s({ ...render, outputs: [{ id: "o1", kind: "script", body: "x" }] })) === null, "an output of a kind the shell doesn't draw is refused");
ok(decode("to-frame", s({ ...render, outputs: [{ id: "o1", kind: "text", body: "x" }, { id: "o1", kind: "text", body: "y" }] })) === null, "a render with two outputs of one id is refused");
ok(decode("to-host", s({ ...committed, height: LIMITS.heightPx + 1 })) === null && decode("to-host", s({ ...committed, generation: -1 })) === null, "a height over the cap, or a negative generation, is refused");
ok(decode("to-frame", s(committed)) === null && decode("to-host", s(render)) === null, "a message of the other direction is refused");
ok(decode("to-host", "not json") === null && decode("to-host", 7) === null, "not JSON, or not a string, is refused");

console.log(failures ? `${failures} of ${checks} failed` : `${checks}/${checks} passed`);
process.exit(failures ? 1 : 0);
