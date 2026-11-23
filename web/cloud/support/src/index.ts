// The support Worker's shared entry: the page (../page.ts), then the API (../support.ts); src/dev.ts and src/prod.ts
// wrap it, prod with production's checks on.  The cron cleans the backstop's old windows.
import { handlePage } from "../page.ts";
import { cleanBackstop, handleApi, type SupportEnv, type SupportOptions } from "../support.ts";

export function supportWorker(opts: SupportOptions) {
  return {
    async fetch(request: Request, env: SupportEnv): Promise<Response> {
      return handlePage(request, env) ?? (await handleApi(request, env, opts)) ?? new Response("not found", { status: 404 });
    },
    async scheduled(_controller: unknown, env: SupportEnv): Promise<void> {
      await cleanBackstop(env.SUPPORT_DB, Date.now());
    },
  };
}
