// Tests only: hold one D1 write between a request's checks and its commit, so a test can end the session meanwhile.
// POST /__hold {"match": "<SQL text>"} arms it: the next batch (or run) with a statement whose SQL contains the text
// waits.  GET /__held answers once a write is waiting.  POST /__release lets it go on.  (Flags polled, not promises:
// workerd cancels a continuation resolved from another request.)
type D1 = NonNullable<import("./server.ts").ShareEnv["SHARE_DB"]>;

let armed: string | null = null;
let waiting = false;
let released = true;
const tagged = new WeakSet<object>();
const tick = () => new Promise((r) => setTimeout(r, 10));

async function wait(): Promise<void> {
  armed = null;
  waiting = true;
  while (!released) await tick();
  waiting = false;
}

/** The test's controls, or null for any other request. */
export async function holdRoute(req: Request): Promise<Response | null> {
  const p = new URL(req.url).pathname;
  if (p === "/__hold" && req.method === "POST") {
    armed = String(((await req.json()) as { match: string }).match);
    released = false;
    return Response.json({ ok: true });
  }
  if (p === "/__held") {
    for (let i = 0; i < 1000 && !waiting; i++) await tick();
    return Response.json({ ok: waiting });
  }
  if (p === "/__release" && req.method === "POST") {
    released = true;
    return Response.json({ ok: true });
  }
  return null;
}

/** `db`, its matching writes held while armed. */
export function holdDb(db: D1): D1 {
  return new Proxy(db, {
    get(t, k) {
      if (k === "prepare") {
        return (sql: string) => {
          const s = t.prepare(sql);
          if (armed === null || !sql.includes(armed)) return s;
          const bind = s.bind.bind(s);
          const mark = (x: ReturnType<typeof s.bind>) => {
            tagged.add(x);
            const run = x.run.bind(x);
            x.run = (async () => (await wait(), run())) as typeof x.run;
            return x;
          };
          s.bind = ((...a: unknown[]) => mark(bind(...a))) as typeof s.bind;
          return mark(s);
        };
      }
      if (k === "batch") return async (stmts: Parameters<D1["batch"]>[0]) => (stmts.some((x) => tagged.has(x)) && (await wait()), t.batch(stmts));
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}
