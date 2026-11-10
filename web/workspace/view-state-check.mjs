// The shared page rows for an editor that keeps where you were in a document (view-state.ts, design r1): each
// adopting editor's page test calls checkViewKept with its own two documents and three expressions, so every editor
// is held to the same rules. A tab is { ev(expression), goto(url), close() } (ev evaluates in the page; goto
// navigates and resolves once the new document is loaded).
//   ready: true once the document is laid out and its kept view applied (or not)
//   set:   changes the view as the person would (and returns it)
//   read:  the view now
//   target (optional): { url, view } a URL whose own target wins over the kept view, and the view it gives
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A document's view kept after another document and back, after a reload and in a new tab; never given to another
 *  document; and a target in the URL winning. */
export async function checkViewKept(check, o) {
  const { name, open, urlOf, docs: [a, b], ready, set, read, same = json } = o;
  const until = async (t, what) => { for (let i = 0; i < 400; i++) { if (await t.ev(ready).catch(() => false)) return; await sleep(25); } throw new Error(`${name}: never ready (${what})`); };
  let t = await open(urlOf(a));
  await until(t, "the first open");
  const v = await t.ev(set);
  await t.goto(urlOf(b));
  await until(t, "the other document");
  const vb = await t.ev(read);
  check(!same(vb, v), `${name}: another document doesn't get its view (${JSON.stringify(vb)})`);
  await t.goto(urlOf(a));
  await until(t, "back");
  let r = await t.ev(read);
  check(same(r, v), `${name}: after another document and back, where you were (${JSON.stringify(r)} vs ${JSON.stringify(v)})`);
  await t.goto(urlOf(a));
  await until(t, "the reload");
  r = await t.ev(read);
  check(same(r, v), `${name}: after a reload, where you were (${JSON.stringify(r)})`);
  await t.close();
  t = await open(urlOf(a));
  await until(t, "a new tab");
  r = await t.ev(read);
  check(same(r, v), `${name}: in a new tab, where you were (${JSON.stringify(r)})`);
  if (o.target) {
    await t.goto(o.target.url);
    await until(t, "the URL's target");
    r = await t.ev(read);
    check(same(r, o.target.view) && !same(r, v), `${name}: a target in the URL wins over the kept view (${JSON.stringify(r)})`);
  }
  await t.close();
  return v;
}
