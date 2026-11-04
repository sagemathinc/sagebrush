// A Miniflare answer, its body read at once: every test and dev server in this
// repository calls Miniflare#dispatchFetch through this (scripts/test-dispatch-census.mjs
// checks that no other call exists).
//
// Why: Miniflare's fetch wraps undici's body stream in a new Response and drops
// undici's own Response, which undici registered in a FinalizationRegistry that
// cancels the stream when that Response is collected.  The stream is shared, so a
// body read only after some later await could find it "already read" (master
// 576f0bf6, run 41798910733: test-share's S4d; reproduced at S5a about one run in
// three, and every time with a forced gc() between the answer and the read).
// Reading the body into a fresh Response in the same microtask chain as the answer
// leaves no task boundary for the collection's cleanup to run in.
//
// An answer that has no body (1xx, 204, 205, 304) is returned as it came.

/** `m.dispatchFetch(url, init)`, its body already read into a new Response. */
export async function dispatch(m, url, init) {
  const r = await m.dispatchFetch(url, init);
  if (r.status < 200 || r.status === 204 || r.status === 205 || r.status === 304) return r;
  const body = await r.arrayBuffer();
  return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
}
