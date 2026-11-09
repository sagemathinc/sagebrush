// The test worker for test-account.mjs: RemoteAccount with a logical clock, reached by name the way a relay reaches
// it.  Never part of the site.
//   /a/<account>/<op>         POST: the object's own route (lease, settle, acquire, release)
//   /a/<account>/__clock?ms=  sets the object's clock;  /a/<account>/__alarm runs its alarm now;  /a/<account>/__state
import { RemoteAccount, type AccountEnv } from "./account.ts";
export { RemoteAccount };

export class TestRemoteAccount extends RemoteAccount {
  private clock = Date.UTC(2026, 10, 6, 12, 0, 0);
  protected now(): number {
    return this.clock;
  }
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname === "/__clock") {
      this.clock = Number(u.searchParams.get("ms"));
      return Response.json({ now: this.clock });
    }
    if (u.pathname === "/__alarm") {
      await this.alarm();
      return Response.json({ alarm: await this.ctx.storage.getAlarm() });
    }
    if (u.pathname === "/__state") {
      const q = (t: string) => this.ctx.storage.sql.exec(`SELECT * FROM ${t}`).toArray();
      return Response.json({ days: q("days"), leases: q("leases"), slots: q("slots"), alarm: await this.ctx.storage.getAlarm() });
    }
    return super.fetch(req);
  }
}

export default {
  async fetch(req: Request, env: AccountEnv & { REMOTE_ACCOUNT: DurableObjectNamespace }): Promise<Response> {
    const u = new URL(req.url);
    const m = /^\/a\/([^/]+)(\/.*)$/.exec(u.pathname);
    if (!m) return new Response("no", { status: 404 });
    const stub = env.REMOTE_ACCOUNT.get(env.REMOTE_ACCOUNT.idFromName(m[1]));
    return stub.fetch(new Request("https://account" + m[2] + u.search, req));
  },
};
