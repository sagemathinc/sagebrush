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
    stored: null, emitted: [], changed: [], notSent: [], demos: [], pairing: null, mayDemo: () => true, kept: null,
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
    host: { load: () => h.load(), store: (s) => h.store(s), pairing: () => h.pairing, demo: h.demo && ((p, e) => h.demo(p, e)), mayDemo: (t) => h.mayDemo(t), emitted: (t, d) => h.emitted.push([t.id, d.type]), changed: (all) => h.changed.push(all), notSent: (why) => h.notSent.push(why) },
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

// kept threads: an empty list, and a current one that names no thread
{
  const { h, host: hs } = host();
  h.kept = { threads: [], current: "x" };
  const s = new ChatSession(hs);
  check(s.state.threads.length === 1 && s.current().title === "New chat", "kept with no threads: one new chat");
  const { h: h2, host: hs2 } = host();
  h2.kept = { threads: [{ id: "a", title: "A", entries: [], artifacts: [], applied_seq: 0 }, { id: "b", title: "B", entries: [], artifacts: [], applied_seq: 0 }], current: "gone" };
  const s2 = new ChatSession(hs2);
  check(s2.current().id === "a", "a current that names no thread: the first", s2.current().id);
}

const failed = results.filter(([ok]) => !ok).length;
console.log(failed ? `test-session: ${failed} failed` : `ok: the agents chat's session, ${results.length} checks`);
process.exit(failed ? 1 : 0);
