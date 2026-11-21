// The Worker that web/cloud/share/test-local-sessions.mjs runs in Miniflare: the share API (test-identity-entry.ts),
// with (tests only) a seam on SHARE_DB that holds, or fails, an idle session's touch: TEST_TOUCH_DELAY_MS waits before
// the UPDATE, TEST_TOUCH_FAIL="1" makes it throw.
import entry from "./test-identity-entry.ts";
import type { ShareEnv } from "./server.ts";

type Stmt = { bind(...v: unknown[]): Stmt; first<T>(): Promise<T | null> };
function seamed(db: NonNullable<ShareEnv["SHARE_DB"]>, delay: number, fail: boolean): ShareEnv["SHARE_DB"] {
  return new Proxy(db, {
    get(t, k) {
      if (k !== "prepare") return Reflect.get(t, k);
      return (sql: string) => {
        const st = t.prepare(sql) as unknown as Stmt;
        if (!sql.startsWith("UPDATE sessions SET last_used")) return st;
        const wrap = (s: Stmt): Stmt => ({
          bind: (...v: unknown[]) => wrap(s.bind(...v)),
          first: async <T>() => {
            if (delay) await new Promise((r) => setTimeout(r, delay));
            if (fail) throw new Error("touch failed (test)");
            return s.first<T>();
          },
        });
        return wrap(st);
      };
    },
  }) as ShareEnv["SHARE_DB"];
}

export default {
  async fetch(req: Request, env: ShareEnv & { TEST_TOUCH_DELAY_MS?: string; TEST_TOUCH_FAIL?: string }, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const delay = Number(env.TEST_TOUCH_DELAY_MS ?? 0), fail = env.TEST_TOUCH_FAIL === "1";
    const e = delay || fail ? { ...env, SHARE_DB: seamed(env.SHARE_DB!, delay, fail) } : env;
    return entry.fetch(req, e, ctx);
  },
};
