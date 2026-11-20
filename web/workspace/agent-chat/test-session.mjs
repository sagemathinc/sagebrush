// ci: web-runner order=373 runner=bun
// The agents chat's conversation (web/workspace/agent-chat/session.ts), apart from any page: the threads it keeps, the
// person's messages and their queue, a scripted turn where the host offers one, the paired agent's turns, a message
// that couldn't go, and the turns a closed page or a lost pairing leave running.
//   bun web/workspace/agent-chat/test-session.mjs
const { ChatSession } = await import("./session.ts");

const results = [];
const check = (ok, what, detail) => { results.push([!!ok, what]); if (!ok) console.log("FAIL", what, JSON.stringify(detail)?.slice(0, 500)); };

/** A host with a scripted turn that waits until it's finished by hand, and a pairing the test sets. */
function host(over = {}) {
  const h = {
    stored: null, emitted: [], replayed: [], changed: [], notSent: [], demos: [], pairing: null, mayDemo: () => true, kept: null,
    load: () => h.kept,
    store: (s) => { h.stored = JSON.parse(JSON.stringify(s)); },
    demo: (prompt, emit) => {
      let finish;
      const turn = { prompt, emit, interrupted: 0, answers: [], interrupt() { turn.interrupted++; }, answer(id, approve) { turn.answers.push([id, approve]); }, done: new Promise((r) => (finish = r)) };
      turn.finish = () => { emit({ type: "turn_finished", outcome: "completed" }); finish(); };
      h.demos.push(turn);
      return turn;
    },
    ...over,
  };
  return {
    h,
    host: { load: () => h.load(), store: (s) => h.store(s), pairing: () => h.pairing, demo: h.demo && ((p, e) => h.demo(p, e)), mayDemo: (t) => h.mayDemo(t), emitted: (t, d, r) => { h.emitted.push([t.id, d.type]); if (r) h.replayed.push([t.id, d.type]); }, changed: (all) => h.changed.push(all), notSent: (why) => h.notSent.push(why) },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
/** A granted pairing that records what it's sent; `answer` says what notifyWhy returns. */
const pairing = (answer = "ok", link = null) => {
  const p = { state: "granted", link, hello: { agent: { name: "Claude" } }, sent: [], notifyWhy(m, params) { p.sent.push([m, params]); return answer; }, notify(m, params) { return p.notifyWhy(m, params) === "ok"; } };
  return p;
};

// a first visit, and kept threads that can't be read: one new chat
{
  const { host: hs } = host();
  const s = new ChatSession(hs);
  check(s.state.threads.length === 1 && s.current().title === "New chat" && s.state.current === s.current().id, "a first visit: one new chat, current", s.state);
  const { h, host: hb } = host();
  h.kept = { threads: "nope" };
  check(new ChatSession(hb).state.threads.length === 1, "kept threads that aren't a list: a new chat instead");
}

// the person's message: empty, inert, a note
{
  const { h, host: hs } = host({ mayDemo: () => false });
  const s = new ChatSession(hs);
  check(s.submit("   ", "sent") === false && s.current().entries.length === 0, "an empty message isn't taken");
  check(s.submit("hello", "sent") === false && s.current().entries.length === 0 && h.demos.length === 0, "not connected, in a chat the demo may not answer: not taken (the draft stays)");
  check(s.submit("a note", "note") === true && s.current().entries.at(-1)?.mode === "note" && h.demos.length === 0, "a note still posts, to nobody");
  check(s.current().title === "a note" && h.stored?.threads?.[0]?.title === "a note", "the first message names the chat, and the chat is kept");
}

// the scripted turn: sent, queued behind it, sent while it runs
{
  const { h, host: hs } = host();
  const s = new ChatSession(hs);
  check(s.submit("first", "sent") && h.demos.length === 1 && s.isRunning(s.current()), "a message starts the scripted turn", h.demos.length);
  check(s.submit("second", "queued") && s.queues.get(s.current().id)?.length === 1, "queued while the turn runs: it waits");
  check(s.submit("third", "sent") && s.queues.get(s.current().id)?.[0]?.text === "third" && h.demos[0].interrupted === 1, "sent while the turn runs: the turn is interrupted, and this goes first");
  h.demos[0].finish();
  await tick();
  check(h.demos.length === 2 && h.demos[1].prompt === "third" && s.current().entries.find((e) => e.text === "third")?.mode === "sent", "when the turn ends, the next message goes", h.demos.map((d) => d.prompt));
  h.demos[1].finish();
  await tick();
  check(h.demos.length === 3 && h.demos[2].prompt === "second" && s.queues.get(s.current().id)?.length === 0, "…and then the one queued before it");
  check(s.submit("fourth", "queued") === true, "queued while a turn runs");
  h.demos[2].finish();
  await tick();
  check(h.demos.length === 4 && h.demos[3].prompt === "fourth", "…goes when it ends");
  h.demos[3].finish();
  await tick();
  check(!s.isRunning(s.current()) && s.submit("fifth", "queued") && h.demos.length === 5, "queued with no turn running: sent at once");
  s.answer(s.current(), "a1", true, "t", "i");
  check(h.demos[4].answers.length === 1 && h.demos[4].answers[0][0] === "a1", "an answer in a scripted turn goes to the turn");
  check(h.changed.includes(true) && h.changed.includes(false), "the host hears what changed: the composer, and the whole thread");
}

// the paired agent
{
  const { h, host: hs } = host();
  const s = new ChatSession(hs);
  h.pairing = pairing("ok");
  const t = s.current();
  check(s.live() && s.submit("hi agent", "sent") && h.demos.length === 0, "connected: the message goes to the agent, not the demo");
  const [m, params] = h.pairing.sent[0] ?? [];
  check(m === "chat.message" && params.conversation === t.id && params.author === "person" && params.text === "hi agent" && typeof params.id === "string", "…as chat.message, with the chat's id and the text", h.pairing.sent);
  check(s.marked(t) && s.isRunning(t), "…the chat is marked as a real agent's, and running");
  s.interrupt(t);
  check(h.pairing.sent.at(-1)?.[0] === "chat.interrupt" && h.pairing.sent.at(-1)?.[1]?.conversation === t.id, "Stop: chat.interrupt for that chat");
  s.onAgent("turn.event", { conversation: t.id, turn_id: "T1", event: { type: "turn_started" } });
  s.onAgent("turn.event", { conversation: t.id, turn_id: "T1", event: { type: "text", text: "hello" } });
  const turn = t.entries.find((e) => e.kind === "turn" && e.turn_id === "T1");
  check(turn && turn.agent === "Claude" && h.emitted.length >= 2, "the agent's events build its turn, named by the agent", { turn, emitted: h.emitted });
  s.onAgent("other.method", { conversation: t.id, turn_id: "T1", event: { type: "text", text: "x" } });
  s.onAgent("turn.event", { conversation: "nope", turn_id: "T1", event: { type: "text", text: "x" } });
  s.onAgent("turn.event", { conversation: t.id, turn_id: 5, event: { type: "text" } });
  check(h.emitted.length === 2, "other methods, other chats and a turn id that isn't text are ignored", h.emitted.length);
  s.submit("next one", "queued");
  s.onAgent("turn.event", { conversation: t.id, turn_id: "T1", event: { type: "turn_finished", outcome: "completed" } });
  check(h.pairing.sent.filter(([m]) => m === "chat.message").at(-1)?.[1]?.text === "next one" && s.isRunning(t), "the turn finished: the queued message goes", h.pairing.sent);
  s.onAgent("turn.event", { conversation: t.id, turn_id: "T1b", event: { type: "turn_started" } });
  s.onAgent("turn.event", { conversation: t.id, turn_id: "T1b", event: { type: "turn_finished", outcome: "completed" } });
  check(!s.isRunning(t) && h.pairing.sent.filter(([m]) => m === "chat.message").length === 2, "the turn finished with nothing queued: the chat isn't running");
  s.submit("again", "sent");
  s.endLive();
  check(!s.isRunning(t), "the pairing ended: nothing is left running");
  const p2 = pairing("ok");
  h.pairing = p2;
  s.onAgent("turn.event", { conversation: t.id, turn_id: "T2", event: { type: "turn_started" } });
  s.submit("x", "sent");
  h.pairing = null;
  s.endLive();
  const t2 = t.entries.find((e) => e.kind === "turn" && e.turn_id === "T2");
  check(t2?.state !== "running" && t2?.outcome === "interrupted", "a turn the agent can no longer finish ends as interrupted", t2);
}

// a message that couldn't go
{
  for (const [answer, link, want] of [["full", {}, "full"], ["over", {}, "over"], ["full", null, "disconnected"], ["closed", {}, "disconnected"]]) {
    const { h, host: hs } = host();
    const s = new ChatSession(hs);
    h.pairing = pairing(answer, link);
    s.submit("m", "sent");
    check(h.notSent.join() === want && !s.isRunning(s.current()), `notifyWhy ${answer}${link ? " over a runner" : ""}: the host says "${want}", and nothing runs`, h.notSent);
  }
}

// a chat a real agent was in, while it's not connected: the message waits
{
  const { h, host: hs } = host({ mayDemo: (t) => !t.agent });
  const s = new ChatSession(hs);
  s.mark(s.current());
  h.mayDemo = (t) => !s.marked(t);
  check(s.submit("later", "sent") === false, "a real agent's chat, not connected: Send is inert");
  h.pairing = { ...pairing("ok"), state: "paired" };
  check(s.submit("later", "sent") === false && h.demos.length === 0, "…paired but not granted yet: still inert, never the demo");
}

// the turns a closed page left running
{
  const { h, host: hs } = host();
  h.kept = { threads: [{ id: "k1", title: "kept", entries: [], artifacts: [], applied_seq: 0 }], current: "k1" };
  const s = new ChatSession(hs);
  s.emit(s.current(), "R1", { type: "turn_started" });
  check(s.current().entries.some((e) => e.kind === "turn" && e.state === "running"), "a kept chat with a running turn", s.current().entries);
  const before = h.emitted.length;
  s.endInterrupted();
  const r = s.current().entries.find((e) => e.kind === "turn" && e.turn_id === "R1");
  check(r?.outcome === "interrupted" && h.emitted.length === before + 1, "endInterrupted: it ends interrupted, once", r);
  s.endInterrupted();
  check(h.emitted.length === before + 1, "…and a second call finds nothing running");
}

// a new chat, and choosing one
{
  const { h, host: hs } = host();
  const s = new ChatSession(hs);
  const first = s.current().id;
  const t = s.newThread();
  check(s.current() === t && s.state.threads.length === 2 && h.stored.current === t.id, "a new chat is current and kept");
  s.select(first);
  check(s.current().id === first && h.stored.current === first, "choosing a chat makes it current, kept");
}

// a note that's only spaces isn't taken; a message is kept trimmed
{
  const { h, host: hs } = host();
  const s = new ChatSession(hs);
  check(s.submit("   ", "note") === false && s.current().entries.length === 0, "a note of only spaces isn't taken");
  check(s.submit("  hi  ", "note") && s.current().entries.at(-1).text === "hi", "a message is kept trimmed", s.current().entries.at(-1));
}

// a queued message's mode is "sent" once it goes, and is kept so
{
  const { h, host: hs } = host();
  const s = new ChatSession(hs);
  s.submit("first", "sent");
  s.submit("later", "queued");
  const later = s.current().entries.find((e) => e.text === "later");
  check(later.mode === "queued", "queued while a turn runs");
  h.demos[0].finish();
  await tick();
  check(later.mode === "sent" && h.stored.threads[0].entries.find((e) => e.text === "later")?.mode === "sent", "once it goes: sent, and kept as sent", h.stored.threads[0].entries.map((e) => [e.text, e.mode]));
}

// the paired agent's permission card: answered once, its state shown, one answer sent
{
  for (const approve of [true, false]) {
    const { h, host: hs } = host();
    const s = new ChatSession(hs);
    const sent = [];
    h.pairing = { state: "granted", link: null, hello: { agent: { name: "Claude" } }, notifyWhy(m, p) { sent.push([m, p]); return "ok"; }, notify(m, p) { sent.push([m, p]); return true; } };
    const t = s.current();
    s.submit("ask me", "sent");
    s.onAgent("turn.event", { conversation: t.id, turn_id: "T1", event: { type: "turn_started" } });
    s.onAgent("turn.event", { conversation: t.id, turn_id: "T1", event: { type: "attention", id: "q1", kind: "approval", state: "open", title: "Allow WebFetch?", summary: "https://example.com", detail: "{}" } });
    const turn = t.entries.find((e) => e.kind === "turn" && e.turn_id === "T1");
    const instance = s.cards.instanceOf("q1");
    check(turn?.attention?.q1?.state === "open" && typeof instance === "string", "the card is shown, open", turn?.attention);
    const before = sent.length;
    check(s.answer(t, "q1", approve, "T1", instance) === true, `${approve ? "Allow" : "Deny"}: the answer is taken`);
    check(turn.attention.q1.state === (approve ? "approved" : "denied"), `${approve ? "Allow" : "Deny"}: the card shows "${approve ? "approved" : "denied"}"`, turn.attention.q1);
    const answers = sent.slice(before).filter(([m]) => m === "chat.permission");
    check(answers.length === 1 && answers[0][1].request_id === "q1" && answers[0][1].behavior === (approve ? "allow" : "deny"), "exactly one answer sent, the person's", answers);
    check(s.answer(t, "q1", !approve, "T1", instance) === false && sent.slice(before).filter(([m]) => m === "chat.permission").length === 1, "a second click answers nothing and sends nothing");
  }
}

// step 1, chat.resume: an agent that keeps each conversation's log (its hello says chat.resume and names its run)
const resumable = (instance = "aaaaaaaaaaaaaaaa", sent = []) => ({ state: "granted", link: null, hello: { agent: { name: "Claude" }, features: ["chat.resume"], log: { instance } }, sent, notifyWhy(m, p) { sent.push([m, p]); return "ok"; }, notify(m, p) { sent.push([m, p]); return true; } });
const ev = (t, seq, turn_id, event) => ["turn.event", { conversation: t.id, turn_id, seq, event }];
const turnOf = (t, id) => t.entries.find((e) => e.kind === "turn" && e.turn_id === id);

// live: numbered events applied once; a finished turn is never reopened
{
  const { h, host: hs } = host();
  const s = new ChatSession(hs);
  h.pairing = resumable();
  const t = s.current();
  s.submit("hi", "sent");
  s.onAgent(...ev(t, 2, "T1", { type: "turn_started" }));
  s.onAgent(...ev(t, 3, "T1", { type: "turn_finished", outcome: "completed" }));
  check(t.agent_seq === 3 && t.agent_instance === "aaaaaaaaaaaaaaaa", "live events: the agent's number and run are kept", [t.agent_seq, t.agent_instance]);
  const n = t.entries.length, applied = t.applied_seq;
  s.onAgent(...ev(t, 3, "T1", { type: "turn_finished", outcome: "error" }));
  s.onAgent(...ev(t, 9, "T1", { type: "turn_started" }));
  check(turnOf(t, "T1").outcome === "completed" && t.entries.length === n && t.applied_seq === applied, "a repeated number, or a finished turn's later event, changes nothing", turnOf(t, "T1"));
}

// the pairing ends with a resumable agent: the running turn is away (not finished, not running, no Stop), and a
// message waits for its end; the replay then finishes it with the agent's own events, and the message goes
{
  const { h, host: hs } = host();
  const s = new ChatSession(hs);
  h.pairing = resumable();
  const t = s.current();
  s.submit("long job", "sent");
  s.onAgent(...ev(t, 2, "T1", { type: "turn_started" }));
  s.onAgent(...ev(t, 3, "T1", { type: "message_revised", message: "m1", revision: 1 }));
  s.endLive(true);
  const turn = turnOf(t, "T1");
  check(turn.away === true && !turn.outcome && !s.isRunning(t) && s.isAway(t), "after the pairing ends: away, not finished, not running", turn);
  h.pairing = null;
  s.submit("and then this", "sent");
  const waiting = t.entries.at(-1);
  check(waiting.mode === "queued", "a message sent while away waits (no one to interrupt)", waiting.mode);
  const sent = [];
  h.pairing = resumable("aaaaaaaaaaaaaaaa", sent);
  s.resume();
  check(sent.length === 1 && sent[0][0] === "chat.resume" && sent[0][1].after === 3 && sent[0][1].instance === "aaaaaaaaaaaaaaaa", "granted again: chat.resume from the last number, with the run", sent);
  s.onAgent("chat.replay", { conversation: t.id, instance: "aaaaaaaaaaaaaaaa", last: 6, done: true, events: [
    { seq: 3, method: "turn.event", params: { conversation: t.id, turn_id: "T1", event: { type: "turn_error", code: "x", message: "already had" } } },
    { seq: 4, method: "turn.event", params: { conversation: t.id, turn_id: "T1", event: { type: "text_delta", message: "m1", revision: 1, text: "done!" } } },
    { seq: 5, method: "turn.event", params: { conversation: t.id, turn_id: "T1", event: { type: "artifact", id: "a1", kind: "markdown", title: "Notes", body: "x" } } },
    { seq: 6, method: "turn.event", params: { conversation: t.id, turn_id: "T1", event: { type: "turn_finished", outcome: "interrupted" } } },
  ] });
  check(!turn.error && turn.parts.some((p) => p.kind === "message" && p.text === "done!"), "the replay applies only what came after the page's number", turn);
  check(turn.outcome === "interrupted" && !turn.away, "the agent's own end finishes the away turn", turn);
  check(h.replayed.some(([, type]) => type === "artifact"), "a replayed artifact is marked replayed (the page doesn't move its pane for it)", h.replayed);
  check(waiting.mode === "sent" && sent.some(([m, p]) => m === "chat.message" && p.text === "and then this"), "the waiting message goes once the turn has ended", sent);
}

// the page reloaded: a running agent turn of a resumable agent's thread is away; a scripted turn still ends interrupted
{
  const { h, host: hs } = host();
  h.kept = { threads: [
    { id: "a", title: "A", entries: [{ kind: "turn", turn_id: "T1", state: "running", parts: [], tools: {}, attention: {}, started: 1, agent: "Claude" }], artifacts: [], applied_seq: 1, agent_seq: 7, agent_instance: "aaaaaaaaaaaaaaaa" },
    { id: "b", title: "B", entries: [{ kind: "turn", turn_id: "T2", state: "running", parts: [], tools: {}, attention: {}, started: 1 }], artifacts: [], applied_seq: 1 },
  ], current: "a" };
  const s = new ChatSession(hs);
  s.endInterrupted();
  check(s.state.threads[0].entries[0].away === true && !s.state.threads[0].entries[0].outcome, "reload: the agent's turn is away", s.state.threads[0].entries[0]);
  check(s.state.threads[1].entries[0].outcome === "interrupted", "reload: a scripted turn ends interrupted, as before", s.state.threads[1].entries[0]);
}

// another run of the agent, or an agent without a log: the away turn ends interrupted; a replay that stops early asks again
{
  for (const kind of ["another run", "no log"]) {
    const { h, host: hs } = host();
    const s = new ChatSession(hs);
    h.pairing = resumable();
    const t = s.current();
    s.submit("x", "sent");
    s.onAgent(...ev(t, 2, "T1", { type: "turn_started" }));
    s.endLive(true);
    const sent = [];
    if (kind === "no log") {
      h.pairing = { ...resumable("bbbbbbbbbbbbbbbb", sent), hello: { agent: { name: "Claude" }, features: [] } };
      s.resume();
    } else {
      h.pairing = resumable("bbbbbbbbbbbbbbbb", sent);
      s.resume();
      s.onAgent("chat.replay", { conversation: t.id, instance: "bbbbbbbbbbbbbbbb", last: 0, reset: true, done: true, events: [] });
    }
    check(turnOf(t, "T1").outcome === "interrupted" && !turnOf(t, "T1").away, `${kind}: the away turn ends interrupted`, turnOf(t, "T1"));
  }
  const { h, host: hs } = host();
  const s = new ChatSession(hs);
  const sent = [];
  h.pairing = resumable("aaaaaaaaaaaaaaaa", sent);
  const t = s.current();
  s.submit("x", "sent");
  s.onAgent("chat.replay", { conversation: t.id, instance: "aaaaaaaaaaaaaaaa", last: 9, done: false, events: [{ seq: 4, method: "turn.event", params: { conversation: t.id, turn_id: "T1", event: { type: "turn_started" } } }] });
  check(sent.some(([m, p]) => m === "chat.resume" && p.after === 4), "a replay that stopped early: asked again from the last number", sent);
}

// another tab's message comes in the replay: shown as sent, once, never queued or sent again
{
  const { h, host: hs } = host();
  const s = new ChatSession(hs);
  const sent = [];
  h.pairing = resumable("aaaaaaaaaaaaaaaa", sent);
  const t = s.current();
  s.submit("from here", "sent");
  const mine = t.entries.at(-1);
  const replay = { conversation: t.id, instance: "aaaaaaaaaaaaaaaa", last: 3, done: true, events: [
    { seq: 1, method: "chat.message", params: { conversation: t.id, id: mine.id, text: "from here", author: "person" } },
    { seq: 2, method: "chat.message", params: { conversation: t.id, id: "other-tab", text: "from there", author: "person" } },
    { seq: 3, method: "chat.rejected", params: { conversation: t.id, id: "x", reason: { code: "busy" } } },
  ] };
  const before = sent.length;
  s.onAgent("chat.replay", replay);
  s.onAgent("chat.replay", replay);
  const users = t.entries.filter((e) => e.kind === "user");
  check(users.length === 2 && users[1].text === "from there" && users[1].mode === "sent", "the other tab's message is shown once, as sent", users);
  check(!sent.slice(before).some(([m]) => m === "chat.message") && !(s.queues.get(t.id) ?? []).length, "and nothing is sent or queued for it", sent.slice(before));
}

// a thread from before chat.resume (no agent_seq): resumed from 0, the whole log replays, and nothing is doubled
{
  const { h, host: hs } = host();
  const s = new ChatSession(hs);
  const sent = [];
  h.pairing = pairing(); // (an agent from before chat.resume: its events unnumbered)
  const t = s.current();
  s.submit("old question", "sent");
  const mine = t.entries.at(-1);
  s.onAgent("turn.event", { conversation: t.id, turn_id: "T0", event: { type: "turn_started" } });
  s.onAgent("turn.event", { conversation: t.id, turn_id: "T0", event: { type: "message_revised", message: "m", revision: 1 } });
  s.onAgent("turn.event", { conversation: t.id, turn_id: "T0", event: { type: "text_delta", message: "m", revision: 1, text: "answer" } });
  s.onAgent("turn.event", { conversation: t.id, turn_id: "T0", event: { type: "turn_finished", outcome: "completed" } });
  check(t.agent_seq === undefined && t.agent_instance === undefined, "an agent without a log: no numbers kept", t);
  h.pairing = resumable("aaaaaaaaaaaaaaaa", sent);
  const before = JSON.stringify(t.entries);
  s.resume();
  check(sent.some(([m, p]) => m === "chat.resume" && p.after === 0 && p.instance === undefined), "an old thread asks from 0", sent);
  s.onAgent("chat.replay", { conversation: t.id, instance: "aaaaaaaaaaaaaaaa", last: 5, done: true, events: [
    { seq: 1, method: "chat.message", params: { conversation: t.id, id: mine.id, text: "old question", author: "person" } },
    { seq: 2, method: "turn.event", params: { conversation: t.id, turn_id: "T0", event: { type: "turn_started" } } },
    { seq: 3, method: "turn.event", params: { conversation: t.id, turn_id: "T0", event: { type: "message_revised", message: "m", revision: 1 } } },
    { seq: 4, method: "turn.event", params: { conversation: t.id, turn_id: "T0", event: { type: "text_delta", message: "m", revision: 1, text: "answer" } } },
    { seq: 5, method: "turn.event", params: { conversation: t.id, turn_id: "T0", event: { type: "turn_finished", outcome: "completed" } } },
  ] });
  check(JSON.stringify(t.entries) === before && t.agent_seq === 5, "the whole log replayed onto it: no message or turn doubled", t.entries);
}

// the real end the agent logged wins over the safety net: an away turn whose replay carries turn_finished(error) ends
// with error, not interrupted
{
  const { h, host: hs } = host();
  const s = new ChatSession(hs);
  h.pairing = resumable();
  const t = s.current();
  s.submit("x", "sent");
  s.onAgent(...ev(t, 2, "T1", { type: "turn_started" }));
  s.endLive(true);
  h.pairing = resumable();
  s.onAgent("chat.replay", { conversation: t.id, instance: "aaaaaaaaaaaaaaaa", last: 4, done: true, events: [
    { seq: 3, method: "turn.event", params: { conversation: t.id, turn_id: "T1", event: { type: "turn_error", code: "agent_error", message: "the page disconnected" } } },
    { seq: 4, method: "turn.event", params: { conversation: t.id, turn_id: "T1", event: { type: "turn_finished", outcome: "error", code: "agent_error" } } },
  ] });
  check(turnOf(t, "T1").outcome === "error" && turnOf(t, "T1").error?.message === "the page disconnected", "the replayed real end wins", turnOf(t, "T1"));
}

// a replay is applied only from the live pairing that said chat.resume, for the run its hello named: a wrong, missing
// or malformed instance, a closed pairing, or an agent that didn't say chat.resume, changes nothing
{
  const cases = [
    ["another run's instance", (h) => resumable("aaaaaaaaaaaaaaaa"), "bbbbbbbbbbbbbbbb"],
    ["no instance", (h) => resumable("aaaaaaaaaaaaaaaa"), undefined],
    ["a malformed instance", (h) => resumable("aaaaaaaaaaaaaaaa"), 42],
    ["a closed pairing", (h) => ({ ...resumable("aaaaaaaaaaaaaaaa"), state: "closed" }), "aaaaaaaaaaaaaaaa"],
    ["no pairing", (h) => null, "aaaaaaaaaaaaaaaa"],
    ["an agent that didn't say chat.resume", (h) => ({ ...resumable("aaaaaaaaaaaaaaaa"), hello: { agent: { name: "Claude" }, features: [], log: { instance: "aaaaaaaaaaaaaaaa" } } }), "aaaaaaaaaaaaaaaa"],
  ];
  for (const [what, pairingOf, instance] of cases) {
    const { h, host: hs } = host();
    const s = new ChatSession(hs);
    h.pairing = resumable("aaaaaaaaaaaaaaaa");
    const t = s.current();
    s.submit("x", "sent");
    s.onAgent(...ev(t, 2, "T1", { type: "turn_started" }));
    s.endLive(true);
    h.pairing = pairingOf(h);
    const before = JSON.stringify(t);
    s.onAgent("chat.replay", { conversation: t.id, instance, last: 99, done: true, events: [
      { seq: 3, method: "chat.message", params: { conversation: t.id, id: "intruder", text: "not from this run", author: "person" } },
      { seq: 4, method: "turn.event", params: { conversation: t.id, turn_id: "T1", event: { type: "turn_finished", outcome: "completed" } } },
    ] });
    check(JSON.stringify(t) === before && turnOf(t, "T1").away === true && t.agent_instance === "aaaaaaaaaaaaaaaa", `a replay with ${what} changes nothing`, t);
  }
}

// SEC H2: with an agent that keeps a log, a live event needs a positive safe-integer number; a replay's last, done
// and every number are checked whole before anything is applied
{
  const bad = [NaN, Infinity, 1.5, -1, 0, 2 ** 53, "3", undefined];
  for (const seq of bad) {
    const { h, host: hs } = host();
    const s = new ChatSession(hs);
    h.pairing = resumable();
    const t = s.current();
    s.submit("x", "sent");
    s.onAgent(...ev(t, 2, "T1", { type: "turn_started" }));
    const before = JSON.stringify(t);
    s.onAgent("turn.event", { conversation: t.id, turn_id: "T1", seq, event: { type: "turn_finished", outcome: "completed" } });
    check(JSON.stringify(t) === before, `a live event numbered ${String(seq)} is dropped`, t);
  }
  const replayCases = [
    ...bad.map((seq) => [`an entry numbered ${String(seq)}`, { last: 9, done: true, seq }]),
    ...[NaN, Infinity, 1.5, -1, 2 ** 53, "9", undefined].map((last) => [`last ${String(last)}`, { last, done: true, seq: 3 }]),
    ["done not a boolean", { last: 9, done: "yes", seq: 3 }],
  ];
  for (const [what, r] of replayCases) {
    const { h, host: hs } = host();
    const s = new ChatSession(hs);
    h.pairing = resumable();
    const t = s.current();
    s.submit("x", "sent");
    s.onAgent(...ev(t, 2, "T1", { type: "turn_started" }));
    s.endLive(true);
    h.pairing = resumable();
    const before = JSON.stringify(t);
    s.onAgent("chat.replay", { conversation: t.id, instance: "aaaaaaaaaaaaaaaa", last: r.last, done: r.done, events: [
      { seq: 3, method: "chat.message", params: { conversation: t.id, id: "fine", text: "fine", author: "person" } },
      { seq: r.seq, method: "turn.event", params: { conversation: t.id, turn_id: "T1", event: { type: "turn_finished", outcome: "completed" } } },
    ] });
    check(JSON.stringify(t) === before, `a replay with ${what} changes nothing, not even its good entries`, t);
  }
}

// SEC H3: every replayed entry must be about this thread, and a message the person's, or the replay changes nothing
{
  const entries = [
    ["a message about another conversation", { seq: 3, method: "chat.message", params: { conversation: "elsewhere", id: "m", text: "x", author: "person" } }],
    ["a message by the agent", { seq: 3, method: "chat.message", params: { conversation: "SELF", id: "m", text: "x", author: "agent" } }],
    ["a message with no author", { seq: 3, method: "chat.message", params: { conversation: "SELF", id: "m", text: "x" } }],
    ["a turn event about another conversation", { seq: 3, method: "turn.event", params: { conversation: "elsewhere", turn_id: "T1", event: { type: "turn_finished", outcome: "completed" } } }],
    ["a turn event with no conversation", { seq: 3, method: "turn.event", params: { turn_id: "T1", event: { type: "turn_finished", outcome: "completed" } } }],
  ];
  for (const [what, e] of entries) {
    const { h, host: hs } = host();
    const s = new ChatSession(hs);
    const sent = [];
    h.pairing = resumable("aaaaaaaaaaaaaaaa", sent);
    const t = s.current();
    s.submit("x", "sent");
    s.onAgent(...ev(t, 2, "T1", { type: "turn_started" }));
    s.endLive(true);
    h.pairing = resumable("aaaaaaaaaaaaaaaa", sent);
    const entry = JSON.parse(JSON.stringify(e).replace('"SELF"', JSON.stringify(t.id)));
    const before = JSON.stringify(t), n = sent.length;
    s.onAgent("chat.replay", { conversation: t.id, instance: "aaaaaaaaaaaaaaaa", last: 3, done: true, events: [entry] });
    check(JSON.stringify(t) === before && sent.length === n && !(s.queues.get(t.id) ?? []).some((q) => q.id === "m"), `${what}: not shown, queued or sent; the thread unchanged`, t);
  }
}

// SEC H4: a click on an away turn's card claims nothing and sends nothing; once the turn is back, it can be answered
{
  const { h, host: hs } = host();
  const s = new ChatSession(hs);
  const sent = [];
  h.pairing = resumable("aaaaaaaaaaaaaaaa", sent);
  const t = s.current();
  s.submit("x", "sent");
  s.onAgent(...ev(t, 2, "T1", { type: "turn_started" }));
  s.onAgent(...ev(t, 3, "T1", { type: "attention", id: "q1", kind: "approval", state: "open", title: "Allow WebFetch?", summary: "https://example.com", detail: "{}" }));
  const instance = s.cards.instanceOf("q1");
  s.endLive(true);
  const n = sent.length;
  check(s.answer(t, "q1", true, "T1", instance) === false && sent.length === n && turnOf(t, "T1").attention.q1.state === "open", "a stale click on an away turn's card: false, nothing sent, the card still open", turnOf(t, "T1").attention.q1);
  // (back, under a new pairing: a card is admitted per pairing, its digest bound to that agent process, so the old
  //  card's token answers nothing; once the agent shows the card again, from the same run, it is answered)
  h.pairing = resumable("aaaaaaaaaaaaaaaa", sent);
  s.cards.clear(); // (as the page does for every new pairing)
  s.onAgent(...ev(t, 4, "T1", { type: "attention", id: "q1", kind: "approval", state: "open", title: "Allow WebFetch?", summary: "https://example.com", detail: "{}" }));
  const again = s.cards.instanceOf("q1");
  check(!turnOf(t, "T1").away && s.answer(t, "q1", true, "T1", again) === true && sent.slice(n).some(([m, p]) => m === "chat.permission" && p.request_id === "q1"), "once the turn is back and its card shown again, it is answered and the answer sent", sent.slice(n));
}

// the real page's rule (no demo once a real agent was in a chat): a message sent while the chat's turn is away waits in
// the queue, whether or not the page is connected yet, and goes once the replay says how the turn went
{
  const { h, host: hs } = host({ mayDemo: () => false });
  const s = new ChatSession(hs);
  const sent = [];
  h.pairing = resumable("aaaaaaaaaaaaaaaa", sent);
  const t = s.current();
  s.submit("job", "sent");
  s.onAgent(...ev(t, 2, "T1", { type: "turn_started" }));
  s.endLive(true);
  h.pairing = null;
  const n = t.entries.length;
  check(s.inert(t) && s.canSend(t), "disconnected with the turn away: not connected (the header says so), but a message can be taken");
  check(s.submit("while disconnected", "sent") === true && t.entries.at(-1).mode === "queued" && t.entries.length === n + 1, "disconnected, away: the message waits in the queue", t.entries.at(-1));
  h.pairing = resumable("aaaaaaaaaaaaaaaa", sent);
  const m = sent.length;
  check(s.submit("while away, connected", "sent") === true && t.entries.at(-1).mode === "queued" && !sent.slice(m).some(([x]) => x === "chat.message" || x === "chat.interrupt"), "connected, the turn still away: the message waits; nothing interrupted or sent", sent.slice(m));
  s.onAgent("chat.replay", { conversation: t.id, instance: "aaaaaaaaaaaaaaaa", last: 3, done: true, events: [{ seq: 3, method: "turn.event", params: { conversation: t.id, turn_id: "T1", event: { type: "turn_finished", outcome: "interrupted" } } }] });
  check(sent.slice(m).some(([x, p]) => x === "chat.message" && p.text === "while disconnected"), "the turn's end known: the first waiting message goes", sent.slice(m));
  // (a chat with no away turn, disconnected: inert as before)
  const u = s.newThread();
  s.mark(u);
  h.pairing = null;
  check(!s.canSend(u) && s.submit("nope", "sent") === false, "disconnected, nothing away, no demo: Send is inert, as before");
}

// SEC H1 (live): an event is read only against the pairing it came through; one from a replaced pairing changes nothing
{
  const { h, host: hs } = host();
  const s = new ChatSession(hs);
  const A = resumable("aaaaaaaaaaaaaaaa");
  h.pairing = A;
  const t = s.current();
  s.submit("x", "sent");
  s.onAgent(...ev(t, 2, "T1", { type: "turn_started" }), A);
  const B = resumable("bbbbbbbbbbbbbbbb");
  h.pairing = B;
  const before = JSON.stringify(t);
  s.onAgent(...ev(t, 3, "T1", { type: "turn_finished", outcome: "completed" }), A);
  check(JSON.stringify(t) === before && t.agent_instance === "aaaaaaaaaaaaaaaa", "a numbered event through the replaced pairing A changes nothing (no new run, no finish)", t);
  s.onAgent(...ev(t, 3, "T2", { type: "turn_started" }), B);
  check(t.agent_instance === "bbbbbbbbbbbbbbbb" && !!turnOf(t, "T2"), "the same through the current pairing B applies, in B's run", t.agent_instance);
}

// step 2: a replay whose `running` names the away turn brings it back to running (Stop shown, its card answerable);
// one naming another id, or several, never makes or binds a turn
{
  const mk = () => {
    const { h, host: hs } = host();
    const s = new ChatSession(hs);
    h.pairing = resumable();
    const t = s.current();
    s.submit("long job", "sent");
    s.onAgent(...ev(t, 2, "T1", { type: "turn_started" }));
    s.endLive(true);
    h.pairing = resumable();
    return { h, s, t };
  };
  {
    const { s, t } = mk();
    s.onAgent("chat.replay", { conversation: t.id, instance: "aaaaaaaaaaaaaaaa", last: 2, done: true, running: ["T1"], events: [] });
    check(!turnOf(t, "T1").away && !turnOf(t, "T1").outcome && s.isRunning(t) && !s.isAway(t), "running names the away turn: it is running again", turnOf(t, "T1"));
    s.onAgent(...ev(t, 3, "T1", { type: "turn_finished", outcome: "completed" }));
    check(turnOf(t, "T1").outcome === "completed" && !s.isRunning(t), "and its later live events finish it", turnOf(t, "T1"));
  }
  {
    const { s, t } = mk();
    s.onAgent("chat.replay", { conversation: t.id, instance: "aaaaaaaaaaaaaaaa", last: 2, done: true, running: ["T-other"], events: [] });
    check(turnOf(t, "T1").outcome === "interrupted" && !t.entries.some((e) => e.kind === "turn" && e.turn_id === "T-other"), "running names another turn: no turn made; the away one ends interrupted", t.entries);
  }
  for (const [what, running] of [["two ids", ["T1", "T2"]], ["not a list", "T1"], ["not strings", [7]], ["null", null], ["an object", { 0: "T1" }]]) {
    const { s, t } = mk();
    const before = JSON.stringify(t);
    s.onAgent("chat.replay", { conversation: t.id, instance: "aaaaaaaaaaaaaaaa", last: 2, done: true, running, events: [] });
    check(JSON.stringify(t) === before, `running as ${what}: the replay changes nothing`, t);
  }
}

// an agent without `running` (the field absent): none; the away turn ends interrupted as in step 1
{
  const { h, host: hs } = host();
  const s = new ChatSession(hs);
  h.pairing = resumable();
  const t = s.current();
  s.submit("x", "sent");
  s.onAgent(...ev(t, 2, "T1", { type: "turn_started" }));
  s.endLive(true);
  h.pairing = resumable();
  s.onAgent("chat.replay", { conversation: t.id, instance: "aaaaaaaaaaaaaaaa", last: 2, done: true, events: [] });
  check(turnOf(t, "T1").outcome === "interrupted", "running absent: as none, the away turn ends interrupted", turnOf(t, "T1"));
}

// kept threads: an empty list, and a current one that names no thread
{
  const { h, host: hs } = host();
  h.kept = { threads: [], current: "x" };
  const s = new ChatSession(hs);
  check(s.state.threads.length === 1 && s.current().title === "New chat", "kept with no threads: one new chat");
  const { h: h2, host: hs2 } = host();
  h2.kept = { threads: [{ id: "a", title: "A", entries: [], artifacts: [], applied_seq: 0 }, { id: "b", title: "B", entries: [], artifacts: [], applied_seq: 0 }], current: "gone" };
  const s2 = new ChatSession(hs2);
  check(s2.current()?.id === "a", "a current that names no thread: the first", s2.current()?.id);
}

// step 3, Steer: with an agent that takes steers (chat.steer), a message while its turn runs goes into that turn, never
// interrupting it; the agent's receipts mark it (steering, delivered, or queued: it runs next on the agent's side)
{
  const steerable = (sent = []) => ({ ...resumable("aaaaaaaaaaaaaaaa", sent), hello: { agent: { name: "Claude" }, features: ["chat.resume", "chat.steer"], log: { instance: "aaaaaaaaaaaaaaaa" } } });
  const mk = (p) => {
    const { h, host: hs } = host();
    const s = new ChatSession(hs);
    const sent = [];
    h.pairing = p(sent);
    const t = s.current();
    s.submit("long job", "sent");
    s.onAgent(...ev(t, 2, "T1", { type: "turn_started" }));
    return { h, s, t, sent };
  };
  {
    const { s, t, sent } = mk(steerable);
    check(s.canSteer(t), "an agent that takes steers, its turn running: the thread can be steered");
    const n = sent.length;
    check(s.submit("go left", "steer"), "a steer is taken");
    const out = sent.slice(n);
    const u = t.entries.at(-1);
    check(out.length === 1 && out[0][0] === "chat.message" && out[0][1].steer === true && out[0][1].text === "go left", "it goes to the agent at once as a steer, and nothing interrupts the turn", out);
    check(u.kind === "user" && u.mode === "steer" && !u.receipt && s.isRunning(t), "shown as a steer, the turn still running", u);
    const r = (seq, state, reason) => ["chat.receipt", { conversation: t.id, id: u.id, state, seq, turn_id: "T1", ...(reason ? { reason } : {}) }];
    s.onAgent(...r(3, "steering"));
    check(u.receipt === "steering", "the agent says it went in: steering", u);
    s.onAgent(...r(4, "delivered"));
    check(u.receipt === "delivered", "…and that Claude took it: delivered", u);
    s.onAgent(...r(5, "steering"));
    check(u.receipt === "delivered", "a later receipt never takes delivered back", u);
    s.onAgent(...r(4, "queued"));
    check(u.receipt === "delivered" && t.agent_seq === 5, "a receipt numbered at or below the last is applied once only", [u, t.agent_seq]);
    s.onAgent("chat.receipt", { conversation: t.id, id: u.id, state: "lost", seq: 6 });
    s.onAgent("chat.receipt", { conversation: t.id, id: "nobody", state: "queued", seq: 7 });
    check(u.receipt === "delivered", "an unknown state, or a receipt for another message, changes nothing", u);
  }
  {
    const { s, t, sent } = mk(steerable);
    s.submit("then this", "steer");
    const u = t.entries.at(-1);
    s.onAgent("chat.receipt", { conversation: t.id, id: u.id, state: "queued", reason: "ended", seq: 3 });
    check(u.receipt === "queued" && u.receipt_reason === "ended", "a steer the agent queued: queued, with why", u);
    const n = sent.length;
    s.onAgent(...ev(t, 4, "T1", { type: "turn_finished", outcome: "completed" }));
    check(!sent.slice(n).some(([m]) => m === "chat.message"), "…and the page never sends it again: the agent runs it next", sent.slice(n));
  }
  {
    const { s, t, sent } = mk((x) => resumable("aaaaaaaaaaaaaaaa", x));
    check(!s.canSteer(t), "an agent that didn't say chat.steer: no steering");
    const n = sent.length;
    s.submit("later", "steer");
    check(t.entries.at(-1).mode === "queued" && !sent.slice(n).some(([m]) => m === "chat.message"), "…a steer is queued on the page, as Queue would", t.entries.at(-1));
  }
  {
    const { h, host: hs } = host();
    const s = new ChatSession(hs);
    const sent = [];
    h.pairing = steerable(sent);
    const t = s.current();
    s.submit("hello", "steer");
    check(t.entries.at(-1).mode === "sent" && sent.some(([m, q]) => m === "chat.message" && !q.steer), "with no turn running, a steer is a plain send", sent);
  }
  {
    const { h, s, t } = mk(steerable);
    h.pairing.notifyWhy = () => "disconnected";
    const before = t.entries.length;
    check(!s.submit("lost", "steer") && t.entries.length === before && h.notSent.length === 1, "a steer that can't go: not taken (the draft stays), and the host says why", h.notSent);
  }
  {
    // (a replay: a steer sent from another tab, and its receipts, from the agent's log)
    const { s, t } = mk(steerable);
    s.onAgent("chat.replay", { conversation: t.id, instance: "aaaaaaaaaaaaaaaa", last: 4, done: true, running: ["T1"], events: [
      { seq: 3, method: "chat.message", params: { conversation: t.id, id: "m9", text: "from elsewhere", author: "person", steer: true } },
      { seq: 4, method: "chat.receipt", params: { conversation: t.id, id: "m9", state: "delivered", turn_id: "T1" } },
    ] });
    const u = t.entries.find((e) => e.kind === "user" && e.id === "m9");
    check(u?.mode === "steer" && u.receipt === "delivered", "a replay shows another tab's steer, delivered", u);
    const before = JSON.stringify(t);
    s.onAgent("chat.replay", { conversation: t.id, instance: "aaaaaaaaaaaaaaaa", last: 5, done: true, running: ["T1"], events: [
      { seq: 5, method: "chat.receipt", params: { conversation: t.id, id: "m9", state: "bogus" } },
    ] });
    check(JSON.stringify(t) === before, "a replay with a malformed receipt changes nothing", t);
  }
}

const failed = results.filter(([ok]) => !ok).length;
console.log(failed ? `test-session: ${failed} failed` : `ok: the agents chat's session, ${results.length} checks`);
process.exit(failed ? 1 : 0);
