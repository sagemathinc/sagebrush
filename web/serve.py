"""Serve web/dist locally as sagebrush.space does, cross-origin isolated
(COOP/COEP, from web/_headers): python3 web/serve.py [port]

Port 0: the system picks a free port, and the server prints it (one line, on
stdout) once it is listening, for a test that starts it and must not race it.

For a test that must see what reaches the server (G-10, web/test-runner.mjs), two optional variables:
  SB_SERVE_LOG=<file>         each request appended as a JSON line: method, path, and its Cookie and Referer
  SB_SERVE_OVERRIDES=<file>   JSON {path: {"file": <a file served instead>} | {"status": 302, "location": <url>}},
                              read on each request (so a test can change it), for that exact path, query included
Without them it serves as before."""
import http.server, json, os, posixpath, sys, urllib.parse

DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")

def rules():
    """The rules of web/dist/_headers: [(path pattern, [(header, value)])],
    one per path, the last given (as Cloudflare keeps them)."""
    out, cur = [], None
    try:
        lines = open(os.path.join(DIST, "_headers")).read().splitlines()
    except OSError:
        return [("/*", [("Cross-Origin-Opener-Policy", "same-origin"), ("Cross-Origin-Embedder-Policy", "require-corp")])]
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():
            cur = (line.strip(), [])
            out.append(cur)
        elif cur and ":" in line:
            k, v = line.strip().split(":", 1)
            cur[1].append((k.strip(), v.strip()))
    return list({p: (p, h) for p, h in out}.values())

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".webmanifest": "application/manifest+json",
                      ".wasm": "application/wasm", ".js": "text/javascript"}

    def end_headers(self):
        # the headers web/dist/_headers gives this path (as the site's host applies them)
        # (the path as the file is found by: decoded and normalized, so that
        # no spelling of a path, /%66rame/ say, escapes its rules; HARD-A75-4)
        raw = urllib.parse.unquote(self.path.split("?")[0].split("#")[0])
        path = posixpath.normpath(raw) + ("/" if raw.endswith("/") and raw != "/" else "")
        for pattern, headers in rules():
            if path == pattern or (pattern.endswith("*") and path.startswith(pattern[:-1])):
                for k, v in headers:
                    self.send_header(k, v)
        super().end_headers()

    def log_message(self, *a):
        pass

    def _record(self):
        log = os.environ.get("SB_SERVE_LOG")
        if log:
            with open(log, "a") as f:
                f.write(json.dumps({"method": self.command, "path": self.path, "cookie": self.headers.get("Cookie"),
                                    "referer": self.headers.get("Referer")}) + "\n")

    def _override(self):
        o = os.environ.get("SB_SERVE_OVERRIDES")
        if not o:
            return False
        try:
            rule = json.load(open(o)).get(self.path)
        except (OSError, ValueError):
            return False
        if not isinstance(rule, dict):
            return False
        if rule.get("status") == 302:
            self.send_response(302)
            self.send_header("Location", rule["location"])
            self.send_header("Content-Length", "0")
            self.end_headers()
            return True
        if "file" in rule:
            body = open(rule["file"], "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(self.path.split("?")[0]))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
            return True
        return False

    def do_GET(self):
        self._record()
        if not self._override():
            super().do_GET()

    def do_HEAD(self):
        self._record()
        if not self._override():
            super().do_HEAD()

os.chdir(DIST)
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)  # (bound and listening from here)
if port == 0:
    print(server.server_address[1], flush=True)
server.serve_forever()
