// `sagebrush notebook [DIR]`: the notebook of sagebrush.space on this
// computer.  A local web server shows the same page; Python runs natively
// here (a Node worker thread per open notebook, src/notebook-session.ts), with
// this computer's files, and each notebook is an .ipynb file in DIR.
//
//   sagebrush notebook [DIR] [--port N] [--no-browser]
//
// Like Jupyter, the server listens on 127.0.0.1 only and needs a random token
// (in the URL it prints and opens; then a cookie); it answers only requests
// for its own host name (no DNS rebinding) and serves files under DIR only.
import * as http from "http";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, renameSync } from "fs";
import { join, resolve, relative, dirname, basename, sep } from "path";
import { randomBytes } from "crypto";
import { Worker, parentPort, workerData } from "worker_threads";
import { spawn } from "child_process";

// ---- the page's files: embedded in the bundle (scripts/build-cli.mjs), or
// web/dist when running from a checkout
// (every script the page loads: web/test-cli-assets.mjs checks the list
// against the page)
const ASSETS = ["index.html", "sagebrush-console.js", "sagebrush-math.js", "sagebrush-viewer3d.js", "sagebrush-history.js", "docs-index.json", "THIRD-PARTY-NOTICES.txt"];
function asset(name: string): Buffer | null {
  const embedded = (globalThis as any).__SAGEBRUSH_WEB__;
  if (embedded) return embedded[name] !== undefined ? Buffer.from(embedded[name], "base64") : null;
  for (const dir of [join(__dirname, "..", "..", "web", "dist"), join(__dirname, "..", "web", "dist")]) {
    const p = join(dir, name);
    if (existsSync(p) && statSync(p).isFile()) return readFileSync(p);
  }
  return null;
}
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", json: "application/json", svg: "image/svg+xml", png: "image/png", txt: "text/plain; charset=utf-8",
};
const typeOf = (name: string) => TYPES[name.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---- the worker thread: one notebook's Python
export function notebookWorker(data: { dir: string }) {
  const { notebookSession } = require("./notebook-session");
  const port = parentPort!;
  const session = notebookSession((m: any) => port.postMessage(m), {
    captureStreams: true,
    init: (R: any) => {
      // the notebook's directory (a virtual working directory: worker
      // threads cannot chdir), and on sys.path, as in Jupyter
      R.importModule("os").chdir(data.dir);
      R.importModule("sys").path.push(data.dir);
    },
  });
  port.on("message", (m: any) => session.handle(m));
  const { R } = require("./compile");
  port.postMessage({ ready: true, version: (globalThis as any).__SAGEBRUSH_VERSION__, interrupt: null, $intr: R.INTR.buffer });
}

interface Session { worker: Worker; intr: Int32Array | null; clients: Set<http.ServerResponse>; backlog: string[]; timer: any }

export async function runNotebookServer(args: string[]) {
  let dir = process.cwd(), port = 8888, browser = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port") port = Number(args[++i]);
    else if (a.startsWith("--port=")) port = Number(a.slice(7));
    else if (a === "--no-browser") browser = false;
    else if (a === "-h" || a === "--help") {
      process.stdout.write("usage: sagebrush notebook [DIR] [--port N] [--no-browser]\n\nThe Sagebrush notebook in your browser, running Python on this computer.\nNotebooks are the .ipynb files in DIR (default: the current directory).\n");
      return;
    } else dir = resolve(a);
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);
  if (!asset("index.html")) throw new Error("this build of sagebrush has no notebook page (build it with `bun web/build.ts`, then `node scripts/build-cli.mjs`)");
  const token = randomBytes(24).toString("hex");
  const sessions = new Map<string, Session>();
  const entry = require.main?.filename ?? process.argv[1];

  // a path under dir, or null
  const inside = (rel: string | null): string | null => {
    if (rel === null) return null;
    const p = resolve(dir, rel.replace(/^\/+/, ""));
    return p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep) ? p : null;
  };

  const startSession = (sid: string, nbDir: string): Session => {
    const worker = new Worker(entry, { workerData: { sagebrushNotebook: { dir: nbDir } }, stdout: false, stderr: false });
    const s: Session = { worker, intr: null, clients: new Set(), backlog: [], timer: null };
    worker.on("message", (m: any) => {
      if (m.$intr) { s.intr = new Int32Array(m.$intr); delete m.$intr; }
      const line = `data: ${JSON.stringify(m)}\n\n`;
      if (s.clients.size) for (const c of s.clients) c.write(line);
      else s.backlog.push(line);
    });
    worker.on("error", (e: any) => {
      const line = `data: ${JSON.stringify({ id: -1, stream: "stderr", text: String(e?.stack ?? e) })}\n\n`;
      for (const c of s.clients) c.write(line);
    });
    sessions.set(sid, s);
    return s;
  };
  const endSession = (sid: string) => {
    const s = sessions.get(sid);
    if (!s) return;
    sessions.delete(sid);
    s.worker.terminate();
    for (const c of s.clients) c.end();
  };

  const body = (req: http.IncomingMessage) => new Promise<Buffer>((res, rej) => {
    const parts: Buffer[] = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => res(Buffer.concat(parts)));
    req.on("error", rej);
  });

  const listing = (rel: string, abs: string) => {
    const entries = readdirSync(abs, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name));
    const link = (p: string) => encodeURIComponent(p).replace(/%2F/g, "/");
    const rows = entries.map((e) => {
      const p = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) return `<li class="d"><a href="/tree/${link(p)}">${esc(e.name)}/</a></li>`;
      if (/\.ipynb$/i.test(e.name)) return `<li class="n"><a href="/nb/${link(p)}">${esc(e.name)}</a></li>`;
      return `<li class="f">${esc(e.name)}</li>`;
    });
    const up = rel ? `<li class="d"><a href="/tree/${link(dirname(rel) === "." ? "" : dirname(rel))}">../</a></li>` : "";
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(rel || basename(dir))} · Sagebrush</title><style>
body{font:15px/1.5 system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:820px;margin:28px auto;padding:0 18px;color:#222;background:#fafaf8}
@media (prefers-color-scheme:dark){body{color:#ddd;background:#16181c}a{color:#8cb4ff}}
h1{font-size:22px;margin:0 0 4px}h1 span{color:#4a7c3a}.p{color:#777;font-size:13px;margin-bottom:16px;word-break:break-all}
ul{list-style:none;padding:0;margin:0;border-top:1px solid #8883}li{padding:6px 4px;border-bottom:1px solid #8883}
li.d a{font-weight:600}li.f{color:#888}button{font:inherit;padding:5px 12px;border-radius:6px;border:1px solid #8886;background:#4a7c3a;color:#fff;cursor:pointer}
</style></head><body><h1><span>Sagebrush</span> notebooks</h1><div class="p">${esc(join(dir, rel))}</div>
<p><button id="new">New notebook</button></p><ul>${up}${rows.join("") || '<li class="f">No notebooks here yet.</li>'}</ul>
<script>document.getElementById("new").onclick=async()=>{let n=prompt("Name of the new notebook","Untitled.ipynb");if(!n)return;if(!/\\.ipynb$/i.test(n))n+=".ipynb";
const p=${JSON.stringify(rel)}?${JSON.stringify(rel)}+"/"+n:n;location.href="/nb/"+encodeURIComponent(p).replace(/%2F/g,"/");};</script></body></html>`;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (host !== "127.0.0.1" && host !== "localhost") { res.writeHead(403).end("forbidden host"); return; }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const cookie = /(?:^|;\s*)sagebrush_token=([0-9a-f]+)/.exec(req.headers.cookie ?? "")?.[1];
      if (url.searchParams.get("token") === token) {
        // trade the token in the URL for a cookie, and drop it from the address bar
        res.writeHead(302, { "Set-Cookie": `sagebrush_token=${token}; Path=/; HttpOnly; SameSite=Strict`, Location: url.pathname });
        res.end();
        return;
      }
      if (cookie !== token) { res.writeHead(403, { "Content-Type": "text/plain" }).end("Open the URL with the token that `sagebrush notebook` printed.\n"); return; }
      const path = decodeURIComponent(url.pathname);
      const method = req.method ?? "GET";

      // the API
      if (/^\/(?:nb\/.+?\.ipynb\/)?api\/file$/i.test(path)) {
        const p = inside(url.searchParams.get("path"));
        if (!p) { res.writeHead(400).end("bad path"); return; }
        if (method === "GET") {
          if (!existsSync(p)) { res.writeHead(404).end("no such file"); return; }
          if (!statSync(p).isFile()) { res.writeHead(400).end("not a file"); return; }
          // read before the headers: a read error still gets a response
          const data = readFileSync(p);
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(data);
        } else if (method === "PUT") {
          const data = await body(req);
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p + ".sagebrush-tmp", data);
          renameSync(p + ".sagebrush-tmp", p); // never a half-written notebook
          res.writeHead(200).end("ok");
        } else res.writeHead(405).end();
        return;
      }
      const m = /^\/(?:nb\/.*\/)?api\/session\/([\w-]+)\/(events|send|interrupt|stop)$/.exec(path);
      if (m) {
        const [, sid, what] = m;
        if (what === "events") {
          // the notebook's directory: from the page's address (…/nb/<path>/api/…)
          const nb = /^\/nb\/(.*)\/api\//.exec(path)?.[1] ?? "";
          const s = sessions.get(sid) ?? startSession(sid, dirname(inside(nb) ?? join(dir, "x")));
          clearTimeout(s.timer);
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
          res.write(": sagebrush\n\n");
          for (const line of s.backlog.splice(0)) res.write(line);
          s.clients.add(res);
          req.on("close", () => {
            s.clients.delete(res);
            // a page that went away (and did not come back): stop its Python
            if (!s.clients.size) s.timer = setTimeout(() => endSession(sid), 30000);
          });
          return;
        }
        const s = sessions.get(sid);
        if (!s) { res.writeHead(404).end("no such session"); return; }
        if (what === "send") s.worker.postMessage(JSON.parse((await body(req)).toString("utf8")));
        else if (what === "interrupt") {
          const { upTo } = JSON.parse((await body(req)).toString("utf8"));
          if (s.intr) { Atomics.store(s.intr, 1, Number(upTo)); Atomics.store(s.intr, 0, 1); }
        } else endSession(sid);
        res.writeHead(200).end("ok");
        return;
      }
      // a directory
      if (path === "/" || path.startsWith("/tree")) {
        const rel = path.replace(/^\/tree\/?/, "").replace(/\/+$/, "");
        const p = inside(rel);
        if (!p || !existsSync(p) || !statSync(p).isDirectory()) { res.writeHead(404).end("no such directory"); return; }
        res.writeHead(200, { "Content-Type": TYPES.html, "Cache-Control": "no-store" }).end(listing(rel, p));
        return;
      }
      // a notebook: the page, told where its file is (its scripts load relative
      // to /nb/<path>/, so they are served under any /nb/ prefix)
      const nbm = /^\/nb\/(.+?\.ipynb)(\/.*)?$/i.exec(path);
      if (nbm && !nbm[2]) {
        // …/nb/a.ipynb -> …/nb/a.ipynb/ (relative URLs then resolve beneath it)
        res.writeHead(302, { Location: "/nb/" + encodeURIComponent(nbm[1]).replace(/%2F/g, "/") + "/" }).end();
        return;
      }
      const rest = nbm ? nbm[2].slice(1) : path.slice(1);
      if (nbm && rest === "") {
        if (!inside(nbm[1])) { res.writeHead(400).end("bad path"); return; }
        const local = { path: nbm[1], name: basename(nbm[1]), dir: relative(dir, dirname(inside(nbm[1])!)) };
        const page = asset("index.html")!.toString("utf8").replace("<head>", `<head><script>window.__SAGEBRUSH_LOCAL__=${JSON.stringify(local).replace(/</g, "\\u003c")};</script>`);
        res.writeHead(200, { "Content-Type": TYPES.html, "Cache-Control": "no-store" }).end(page);
        return;
      }
      if (ASSETS.includes(rest) || /^katex\/[\w.\-\/]+$/.test(rest)) {
        const data = asset(rest);
        if (data) { res.writeHead(200, { "Content-Type": typeOf(rest), "Cache-Control": "no-cache" }).end(data); return; }
      }
      res.writeHead(404).end("not found");
    } catch (e: any) {
      if (!res.headersSent) res.writeHead(500).end(String(e?.message ?? e));
    }
  });

  // the first free port from the one asked for
  for (let tries = 0; ; tries++) {
    const ok = await new Promise<boolean>((res, rej) => {
      server.once("error", (e: any) => (e.code === "EADDRINUSE" && tries < 50 ? res(false) : rej(e)));
      server.listen(port, "127.0.0.1", () => res(true));
    });
    if (ok) break;
    port++;
  }
  const url = `http://127.0.0.1:${port}/?token=${token}`;
  process.stdout.write(`Sagebrush notebook: serving ${dir}\n  ${url}\n(Ctrl-C stops it)\n`);
  if (browser) openBrowser(url);
  process.on("SIGINT", () => { for (const sid of [...sessions.keys()]) endSession(sid); process.exit(0); });
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

export const isNotebookWorker = () => !!workerData?.sagebrushNotebook;
