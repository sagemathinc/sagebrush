// The frame's answer channel (channel.ts) against a host that never
// answers (HARD-B21-1): a submission sent again and again is one promise,
// one id waiting; ids for changed answers past SUBMITS_MAX give up the
// oldest, its waiter told "unanswered"; decisions past DECIDES_MAX too; and
// close() settles all of it.  What waits is bounded by those constants,
// however long the page stays open.  And a host's answers settle only the
// id they name.
//   bun web/board/test-channel.mjs
import { answerChannel, SUBMITS_MAX, DECIDES_MAX, uuid } from "./channel.ts";

let failed = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const answers = (n) => ({ page: { number: 1 }, answers: { q: n }, notes: {}, comment: "" });

// a silent host: it reads what is sent and never answers
const { port1, port2 } = new MessageChannel();
const sent = [];
port2.onmessage = (e) => sent.push(e.data);
const ch = answerChannel(port1, "b.board.json", "r1");
check(SUBMITS_MAX === 8 && DECIDES_MAX === 8, "the bounds: 8 submissions and 8 decisions waiting at most");

// the same id sent again 50 times: one promise, one id waiting, sent each time
const id = uuid(), first = ch.submit(id, answers(1));
let same = true;
for (let k = 0; k < 49; k++) same = same && ch.submit(id, answers(1)) === first;
await sleep(50);
check(same, "an id sent again is the same promise each time");
check(ch.waiting().submits === 1, "and one id waiting: " + JSON.stringify(ch.waiting()));
check(sent.length === 50 && sent.every((m) => m.sagebrush === "answers" && m.id === id), "each send posted, with that id");

// changed answers, a new id each time, 40 of them: never more than SUBMITS_MAX waiting
const settled = [];
first.then((r) => settled.push(["first", r]));
const ids = [], promises = [];
let most = 0;
for (let k = 0; k < 40; k++) {
  const i = uuid();
  ids.push(i);
  const p = ch.submit(i, answers(k + 2));
  promises.push(p);
  p.then((r) => settled.push([i, r]));
  most = Math.max(most, ch.waiting().submits);
}
await sleep(50);
check(most === SUBMITS_MAX && ch.waiting().submits === SUBMITS_MAX, `changed answers, 40 new ids: at most ${SUBMITS_MAX} waiting (${most})`);
check(settled.some(([w, r]) => w === "first" && r.unanswered), "the oldest given up on, its waiter told it is unanswered");
check(settled.filter(([, r]) => r.unanswered).length === 41 - SUBMITS_MAX, `every id given up on settled: ${41 - SUBMITS_MAX} of them`);

// a host's answer settles the id it names, once; an id given up on stays so
port2.postMessage({ sagebrush: "received", version: 1, id: ids[39] });
port2.postMessage({ sagebrush: "received", version: 1, id: ids[0] });
await sleep(50);
check(settled.some(([w, r]) => w === ids[39] && r.received), "received settles its id");
check(ch.waiting().submits === SUBMITS_MAX - 1, "and that id waits no more: " + JSON.stringify(ch.waiting()));
check(settled.filter(([w]) => w === ids[0]).length === 1, "an id given up on is settled once, a late answer to it ignored");

// decisions: at most DECIDES_MAX waiting, the oldest refused
const decided = [];
for (let k = 0; k < 20; k++) ch.decide({ number: 1 }, "q", "words " + k).then((r) => decided.push(r));
await sleep(50);
check(ch.waiting().decides === DECIDES_MAX, `20 decisions asked: ${DECIDES_MAX} waiting`);
check(decided.length === 20 - DECIDES_MAX && decided.every((r) => r.refused), "the others refused, saying why: " + JSON.stringify(decided[0]));

// closed: everything waiting settled, nothing more waits or is sent
const before = sent.length;
ch.close();
await sleep(50);
check(ch.waiting().submits === 0 && ch.waiting().decides === 0, "closed: nothing waits");
check(settled.filter(([, r]) => r.unanswered).length === 41 - SUBMITS_MAX + SUBMITS_MAX - 1, "every submission waiting settled, unanswered");
check(decided.length === 20, "every decision waiting settled");
const after = await ch.submit(uuid(), answers(0));
check(after.unanswered && sent.length === before, "a submission after close: unanswered at once, not sent");
port2.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
