"""Serve web/dist locally as sagebrush.space does, cross-origin isolated
(COOP/COEP, from web/_headers): python3 web/serve.py [port]"""
import http.server, os, posixpath, sys, urllib.parse

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

os.chdir(DIST)
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8765), Handler).serve_forever()
