// `sagebrush board open FILE`: a board on this computer, in the browser, as
// sagebrush.space shows it, following the file as it changes (an agent
// rewriting it, an editor saving it).  Loaded only for this command
// (src/board-cli.ts).
//
//   sagebrush board open FILE [--port N] [--no-browser]
//
// The page is the frame other sites show a board in (/frame/board/,
// design/frame.md), with its document marked as this computer's
// (data-sb-from="local", web/board/page.ts): served sandboxed, with the
// policy the site serves it with, so a board's text never runs as this
// server's origin.  Its code runs in the page, in the runner's files mode,
// on the engine it was built with, fetched from sagebrush.space and checked
// (web/board/engine.ts); nothing of the board is sent anywhere.
//
// Like `sagebrush notebook` (src/notebook.ts): it listens on 127.0.0.1 only,
// needs the random token in the URL it prints and opens (then a cookie), and
// answers only requests for its own host and port (no DNS rebinding).  It
// serves the page and FILE's text only, no other file and no directory:
// the board's pictures are in the file.  The page, being sandboxed, has no
// cookie: its two requests (the file's text, its changes) carry a second
// random key, which the server puts in the page.
//
// The file is checked for changes by its stat, every WATCH_MS, and read
// again at most once per WATCH_MS, after it has been quiet for QUIET_MS;
// read in pieces, never past FILE_MAX (what the board opens).  The page reads
// it again only when its revision (SHA-256 of its bytes) changed.
import * as http from "http";
import { createReadStream, existsSync, readFileSync, realpathSync, statSync, watchFile, unwatchFile, type Stats } from "fs";
import { basename, join, resolve } from "path";
import { createHash, randomBytes } from "crypto";
import { gunzipSync } from "zlib";
import { spawn } from "child_process";
import { FILE_MAX, readBounded } from "./board-check";
import { oneLine } from "./terminal-text";
import { limitsHelp, resolveLimits, type Limits } from "./board-edit-limits";

const SENTENCE_OUTSIDE = "Outside edits: if a program changes the file after reading the board's latest save, its change merges in exactly. If it starts from an older copy, the board can't know what that program saw. It handles the change carefully, but can't guarantee an exact result. The board sees changes by reading the file, so it can miss a change that is replaced before it reads it, or one written through a file handle opened before one of its saves. While the board saves, the file is missing for a moment, so a program opening it right then may need to try again.";
const SENTENCE_DURABLE = "Durability: an edit is safe once the page shows 'Saved'. Anything typed before that can be lost, for example if the tab closes. There's deliberately no recovery store, but Save now and Download are always available.";

const USAGE = `usage: sagebrush board open FILE [--port N] [--no-browser] [--edit [--limit NAME=VALUE]...]
  show the board FILE (its .board.json, a Mermaid flowchart, Markdown with
  some, a JSON Canvas, a CoCalc whiteboard) in your browser, as
  sagebrush.space/board does, and again each time FILE changes: write it,
  check it (sagebrush board check FILE), and watch it here.  Its code runs in
  the page; nothing of the board is uploaded.  A version that isn't a board
  (half written, or wrong) leaves the last good one shown, with what is wrong.
  Without --edit, the page is a read-only view of FILE: to change the board,
  change the file.
  --port N        the first port to try (default 8890)
  --no-browser    print the URL, don't open a browser
  --edit          edit the board in the page, saved back to FILE (a native
                  .board.json only; the first save rewrites it in the board's
                  own layout, every field kept).
                  ${SENTENCE_OUTSIDE}
                  ${SENTENCE_DURABLE}
  --limit NAME=VALUE   one of --edit's limits (or SAGEBRUSH_BOARD_OPEN_NAME in
                  the environment; the flag wins), all checked before it starts:
${limitsHelp()}
`;

/** How often FILE's stat is checked, and how long it must be quiet before it is read (ms). */
export const WATCH_MS = 250, QUIET_MS = 150;
/** At most this many pages follow the file at once (each an event stream). */
export const MAX_CLIENTS = 16;
/** At most this many connections at once, whatever they ask for (those not yet past their headers too); one
 * more is closed at once (daybreak2's LIM-BOARDOPEN-1).  The 16 event streams are among them. */
export const MAX_CONNECTIONS = 64;
/** How long a connection may take to send its headers, its whole request, and stay idle between requests (ms);
 * checked every second. */
export const HEADERS_MS = 10_000, REQUEST_MS = 30_000, KEEP_ALIVE_MS = 5_000;
/** How many bytes may wait to be sent to one page following the file; a page that doesn't take them (stopped
 * reading) is closed instead (daybreak2's LIM-BOARDOPEN-2).  An event is under 100 bytes. */
export const PENDING_MAX = 64 * 1024;

/** The pages following the file: each an event stream, sent to only while it keeps up. */
export class Followers {
  private set = new Set<{ writableLength: number; write(s: string): unknown; destroy(): unknown; end(): unknown }>();
  constructor(readonly max = MAX_CLIENTS, readonly pendingMax = PENDING_MAX) {}
  get size() { return this.set.size; }
  /** Take this stream, if there is room. */
  add(c: { writableLength: number; write(s: string): unknown; destroy(): unknown; end(): unknown }): boolean {
    if (this.set.size >= this.max) return false;
    this.set.add(c);
    return true;
  }
  remove(c: object) { this.set.delete(c as any); }
  /** `text` to one stream, or, if what waits for it would pass the bound, the stream closed and dropped. */
  send(c: { writableLength: number; write(s: string): unknown; destroy(): unknown }, text: string): boolean {
    if (c.writableLength + Buffer.byteLength(text) > this.pendingMax) {
      this.set.delete(c as any);
      c.destroy();
      return false;
    }
    c.write(text);
    return true;
  }
  /** `text` to every stream (each kept to the bound). */
  broadcast(text: string) { for (const c of [...this.set]) this.send(c, text); }
  close() { for (const c of [...this.set]) c.end(); this.set.clear(); }
}
/** The site the page's engine comes from, unless this checkout has it built (web/dist/engine/<id>/). */
const ENGINE_SITE = "https://sagebrush.space/";

// the page's files: embedded in the bundle (scripts/build-cli.mjs), or web/dist when running from a checkout
function asset(name: string): Buffer | null {
  const embedded = (globalThis as any).__SAGEBRUSH_WEB__;
  if (embedded) return embedded[name] !== undefined ? Buffer.from(embedded[name], "base64") : null;
  for (const dir of webDirs()) {
    const p = join(dir, name);
    if (existsSync(p) && statSync(p).isFile()) return readFileSync(p);
  }
  return null;
}
/** The frame's page: the bundle's gzipped copy, or a checkout's web/dist. */
function framePage(): Buffer | null {
  const embedded = (globalThis as any).__SAGEBRUSH_WEB__;
  if (embedded) return embedded["frame/board/index.html.gz"] !== undefined ? gunzipSync(Buffer.from(embedded["frame/board/index.html.gz"], "base64")) : null;
  return asset("frame/board/index.html");
}
const webDirs = () => [join(__dirname, "..", "..", "web", "dist"), join(__dirname, "..", "web", "dist")];

/** The policy the site serves its frame with (web/csp-policy.mts framePolicy, in web/dist/_headers), with
 * no page allowed to frame this one. */
export function framePolicyOf(headers: string): string | null {
  const m = /^\/frame\/\*\r?\n((?:[ \t]+.*\r?\n?)*)/m.exec(headers);
  const csp = m && /^[ \t]+Content-Security-Policy:[ \t]*(.+?)\s*$/m.exec(m[1])?.[1];
  if (!csp || !/\bsandbox allow-scripts\b/.test(csp) || !/frame-ancestors \*/.test(csp)) return null;
  return csp.replace("frame-ancestors *", "frame-ancestors 'none'");
}

/** The frame's page as this command serves it: its document this computer's, the key and name its requests
 * use, and the site its engine comes from; null if the page isn't one this command knows how to change. */
export function localPage(frame: string, o: { key: string; name: string; engineSite: string; edit?: boolean }): string | null {
  const marks = frame.split('id="sb-doc" data-sb-from="parent"').length - 1;
  if (marks !== 1) return null;
  // (HTML-safe JSON: no "<", ">" or "&", so no "</script>" or "<!--", and no U+2028 or U+2029, each \uXXXX)
  const json = (v: unknown) => JSON.stringify(v).replace(/[<>&\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const parts = `<script type="application/json" id="sb-local">${json({ key: o.key, name: o.name, engineSite: o.engineSite, ...(o.edit ? { edit: true } : {}) })}</script>`;
  const page = frame.replace('id="sb-doc" data-sb-from="parent"', 'id="sb-doc" data-sb-from="local"');
  const at = page.indexOf("</head>");
  return at < 0 ? null : page.slice(0, at) + parts + page.slice(at);
}

/** A checkout's built engine (web/dist/engine/<id>/, the one the page beside it was built with), when the page
 * is that checkout's too: its id, directory and files; else null, and the page's engine comes from
 * sagebrush.space (always, from a bundle that carries its page, as installed). */
function localEngine(frame: string): { id: string; dir: string; files: Record<string, unknown> } | null {
  if ((globalThis as any).__SAGEBRUSH_WEB__) return null;
  for (const d of webDirs()) {
    try {
      const id = JSON.parse(readFileSync(join(d, "engine", "latest.json"), "utf8"))?.id;
      // (the page's own engine only: its script names it)
      if (typeof id !== "string" || !/^[0-9a-f]{20}$/.test(id) || !frame.includes(`"${id}"`)) continue;
      const dir = join(d, "engine", id), man = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      if (man?.id === id && man.files && typeof man.files === "object") return { id, dir, files: man.files };
    } catch {}
  }
  return null;
}

const sameStat = (a: Stats | null, b: Stats | null) => !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.ctimeMs === b.ctimeMs;

export async function boardOpen(argv: string[]): Promise<number> {
  let file: string | null = null, port = 8890, browser = true, edit = false;
  const limitFlags: string[] = [];
  const say = (m: string) => process.stderr.write(`sagebrush board open: ${oneLine(m)}\n`);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { process.stdout.write(USAGE); return 0; }
    if (a === "--port" || a.startsWith("--port=")) {
      port = Number(a === "--port" ? argv[++i] : a.slice(7));
      if (!Number.isInteger(port) || port < 1 || port > 65535) { say("--port takes a port number, from 1 to 65535"); return 2; }
    } else if (a === "--no-browser") browser = false;
    else if (a === "--edit") edit = true;
    else if (a === "--limit" || a.startsWith("--limit=")) {
      const v = a === "--limit" ? argv[++i] : a.slice(8);
      if (v === undefined) { say("--limit takes NAME=VALUE"); return 2; }
      limitFlags.push(v);
    }
    else if (a.startsWith("-")) { say(`unknown option ${a}`); process.stderr.write(USAGE); return 2; }
    else if (file === null) file = a;
    else { process.stderr.write(USAGE); return 2; }
  }
  if (file === null) { process.stderr.write(USAGE); return 2; }
  if (limitFlags.length && !edit) { say("--limit is for --edit"); return 2; }
  let limits: Limits | null = null;
  if (edit) {
    const r = resolveLimits(limitFlags, process.env);
    if ("error" in r) { say(r.error); return 2; }
    limits = r.limits;
  }
  if (!existsSync(file)) { say(`${file}: no such file`); return 1; }
  // (with --edit, a symlink's target is what is written: FILE resolved to its real path, §5.4)
  const path = edit ? realpathSync(file) : resolve(file), name = basename(path);
  if (!statSync(path).isFile()) { say(`${file}: not a file`); return 1; }
  const frame = framePage(), headers = asset("_headers");
  const policy = headers ? framePolicyOf(headers.toString("utf8")) : null;
  if (!frame || !policy) { say("this build of sagebrush has no board page (build it with `bun web/build.ts`, then `node scripts/build-cli.mjs`)"); return 1; }
  const served = localEngine(frame.toString("utf8"));

  // ---- --edit: the hub on FILE as found, or the reason it is shown read only (r7 §9)
  let editing: { hub: import("./board-edit-hub").EditHub; server: import("./board-edit-serve").EditServer; watch: import("./board-edit-serve").EditWatch } | null = null;
  if (edit && limits) {
    const { startEdit, EditServer, EditWatch } = await import("./board-edit-serve");
    const { mergeStrings3 } = await import("patchflow");
    const started = await startEdit(path, limits, { mergeStrings3: mergeStrings3 as any, now: Date.now });
    if ("why" in started) say(`not editing: ${started.why} (shown read only)`);
    else {
      const editApi = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "X-Sagebrush-Seq, Retry-After", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
      const server = new EditServer(started.hub, limits, editApi, Date.now);
      const statOf = (p: string) => { try { const s = statSync(p); return `${s.size}:${s.mtimeMs}:${s.ino}:${s.ctimeMs}`; } catch { return null; } };
      editing = { hub: started.hub, server, watch: new EditWatch(started.hub, server, path, limits.FILE_MAX, QUIET_MS, statOf) };
    }
  }

  const token = randomBytes(24).toString("hex"), key = randomBytes(24).toString("hex");
  // (named for its port, set once it listens: another server on 127.0.0.1, `sagebrush notebook`'s, keeps its own)
  let cookieName = "", page: Buffer | null = null;

  // ---- FILE: its bytes and revision, read when it has changed and been quiet; the pages following it told
  const clients = new Followers();
  let current: { stat: Stats | null; bytes: Buffer | null; revision: string; error: string | null } = { stat: null, bytes: null, revision: "", error: null };
  const read = () => {
    let stat: Stats | null = null;
    try { stat = statSync(path); } catch {}
    if (stat && sameStat(stat, current.stat)) return;
    let bytes: Buffer | null = null, error: string | null = null;
    try {
      if (!stat) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      if (!stat.isFile()) throw new Error("not a file");
      bytes = readBounded(path, FILE_MAX);
      if (bytes === null) error = `too large for the board to open (at most ${FILE_MAX / 2 ** 20} MB)`;
    } catch (e: any) {
      error = e?.code === "ENOENT" ? "no such file (moved or deleted?)" : String(e?.message ?? e);
    }
    const revision = createHash("sha256").update(bytes ?? Buffer.from("error:" + error)).digest("hex");
    const changed = revision !== current.revision;
    current = { stat, bytes: error ? null : bytes, revision, error };
    if (changed) clients.broadcast(`event: board\ndata: ${revision}\n\n`);
  };
  let quiet: NodeJS.Timeout | null = null, lastRead = 0;
  const changed = () => {
    if (quiet) clearTimeout(quiet);
    quiet = setTimeout(() => {
      quiet = null;
      // (at most one read per WATCH_MS, whatever the file does)
      const wait = lastRead + WATCH_MS - Date.now();
      if (wait > 0) { quiet = setTimeout(changed, wait); return; }
      lastRead = Date.now();
      read();
    }, QUIET_MS);
  };
  let ticks: NodeJS.Timeout | null = null;
  if (editing) {
    // (FILE followed by the hub: read, merged and saved by its watch, every WATCH_MS)
    const e = editing;
    ticks = setInterval(() => { e.watch.tick(Date.now()).catch((err) => say(`while editing: ${err?.message ?? err}`)); }, WATCH_MS);
    current = { stat: null, bytes: e.hub.H.bytes, revision: e.hub.H.hash, error: null };
  } else {
    read();
    watchFile(path, { interval: WATCH_MS, persistent: true }, (now, before) => { if (!sameStat(now, before)) changed(); });
  }

  const forbidden = (res: http.ServerResponse, why: string) => res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end(why);
  // (the timeouts below are checked every second: by default only every 30 s, so a connection could outlive them)
  const server = http.createServer({ connectionsCheckingInterval: 1000 }, (req, res) => {
    try {
      // (its own host and port only: no DNS rebinding)
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return forbidden(res, "forbidden host\n");
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const editRequest = !!editing && url.pathname === "/edit";
      if (req.method !== "GET" && req.method !== "HEAD" && !editRequest) return res.writeHead(405, { Allow: "GET, HEAD" }).end();
      // the page's two requests, from its opaque origin: by the key, readable from there (CORS), never cached
      const api = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "X-Sagebrush-Revision", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
      if (url.pathname === "/board" || url.pathname === "/events" || editRequest) {
        // (by the key, which only the page has; and from the page only: its opaque origin, "null", or no Origin
        // at all, never another site's or another port's page)
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== "null") return forbidden(res, "forbidden origin\n");
        if (url.searchParams.get("key") !== key) return forbidden(res, "forbidden\n");
        // (--edit's own: a tab's events, heads and submissions)
        if (editing && editing.server.handle(req, res, url)) return;
        if (url.pathname === "/board") {
          const c = editing ? { error: null, bytes: editing.hub.H.bytes, revision: editing.hub.H.hash } : current;
          if (c.error || !c.bytes) return res.writeHead(c.error?.startsWith("too large") ? 413 : 409, { ...api, "Content-Type": "text/plain; charset=utf-8", "X-Sagebrush-Revision": c.revision }).end(c.error ?? "unreadable");
          return res.writeHead(200, { ...api, "Content-Type": "text/plain; charset=utf-8", "Content-Length": String(c.bytes.length), "X-Sagebrush-Revision": c.revision }).end(req.method === "HEAD" ? undefined : c.bytes);
        }
        if (!clients.add(res)) return res.writeHead(503, { ...api, "Content-Type": "text/plain" }).end(`at most ${MAX_CLIENTS} pages follow a board at once\n`);
        res.writeHead(200, { ...api, "Content-Type": "text/event-stream" });
        clients.send(res, `retry: 2000\n\nevent: board\ndata: ${current.revision}\n\n`);
        req.on("close", () => clients.remove(res));
        return;
      }
      // the engine, from a checkout that built it (else the page fetches it from sagebrush.space): its files only
      const em = /^\/engine\/([0-9a-f]{20})\/([a-z0-9][a-z0-9./-]*)$/.exec(url.pathname);
      if (em && served && em[1] === served.id && !em[2].includes("..") && (em[2] === "manifest.json" || Object.hasOwn(served.files, em[2]))) {
        const p = join(served.dir, em[2]);
        // (streamed, not read whole: an engine's wasm is megabytes)
        if (existsSync(p)) {
          res.writeHead(200, { ...api, "Cache-Control": "no-cache", "Content-Type": "application/octet-stream" });
          if (req.method === "HEAD") return res.end();
          const f = createReadStream(p);
          f.on("error", () => res.destroy());
          res.on("close", () => f.destroy());
          return void f.pipe(res);
        }
      }
      // the page: for whoever has the token (in the URL once, then its cookie)
      if (url.pathname !== "/") return res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("not found\n");
      if (url.searchParams.get("token") === token) {
        return res.writeHead(302, { "Set-Cookie": `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict`, Location: "/", "Cache-Control": "no-store" }).end();
      }
      const cookie = new RegExp(`(?:^|;\\s*)${cookieName}=([0-9a-f]+)`).exec(req.headers.cookie ?? "")?.[1];
      if (cookie !== token) return forbidden(res, "Open the URL with the token that `sagebrush board open` printed.\n");
      if (!page) return res.writeHead(500, { "Content-Type": "text/plain" }).end("this build's board page isn't one `sagebrush board open` knows how to serve\n");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": policy, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
      res.end(req.method === "HEAD" ? undefined : page);
    } catch (e: any) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" }).end(String(e?.message ?? e));
    }
  });
  // (its connections bounded, in number and in how long a request may take: LIM-BOARDOPEN-1)
  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = HEADERS_MS;
  server.requestTimeout = REQUEST_MS;
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  // (event streams kept open: a comment now and then, through any idle timeout)
  const beat = setInterval(() => { clients.broadcast(": .\n\n"); editing?.server.beat(); }, 25_000);
  beat.unref();

  // the first free port from the one asked for
  for (let tries = 0; ; tries++) {
    const ok = await new Promise<boolean>((done, fail) => {
      server.once("error", (e: any) => (e.code === "EADDRINUSE" && tries < 50 && port < 65535 ? done(false) : fail(e)));
      server.listen(port, "127.0.0.1", () => done(true));
    });
    if (ok) break;
    port++;
  }
  cookieName = `sagebrush_board_${port}`;
  // (the page, made once: the same for every request)
  const made = localPage(frame.toString("utf8"), { key, name, engineSite: served ? `http://127.0.0.1:${port}/` : ENGINE_SITE, ...(editing ? { edit: true } : {}) });
  page = made === null ? null : Buffer.from(made, "utf8");
  const open = `http://127.0.0.1:${port}/?token=${token}`;
  process.stdout.write(editing
    ? `Sagebrush board: editing ${path} (saved back to the file; it follows changes to the file)\n  ${open}\n(Ctrl-C stops it, after a last save)\n`
    : `Sagebrush board: showing ${path} (a read-only view: it follows changes to the file)\n  ${open}\n(Ctrl-C stops it)\n`);
  if (browser) openBrowser(open);
  await new Promise<void>((done) => {
    const stop = async () => {
      if (ticks) clearInterval(ticks);
      // (the exit flush, r7 §5.6: one last save of what is unsaved, the same steps, within EXIT_FLUSH_MS)
      if (editing && limits && limits.EXIT_FLUSH_MS > 0 && editing.hub.unsaved()) {
        try {
          const r = await Promise.race([editing.hub.save(), new Promise<null>((ok) => setTimeout(() => ok(null), limits!.EXIT_FLUSH_MS).unref())]);
          if (!r || !r.saved) say("stopped with edits not saved to the file");
        } catch (e: any) { say(`stopped with edits not saved to the file: ${e?.message ?? e}`); }
      }
      unwatchFile(path); clearInterval(beat); clients.close(); editing?.server.close(); server.close(); server.closeAllConnections(); done();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

function openBrowser(url: string) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const p = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } catch {
    // no browser here: the URL was printed
  }
}
