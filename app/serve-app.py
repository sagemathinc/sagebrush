"""Serve app/dist as the app serves it (app/src-tauri/src/lib.rs: the localhost
plugin's on_request), for a test of the app's page in a browser:
  python3 app/serve-app.py [--no-coi] [port]

Every response: COOP/COEP, as the desktop app's (--no-coi: without them, as
Android's web view, which is not cross-origin isolated); the Terminal's
shell worker (/shell/worker-boot.js): the CSP lib.rs's SHELL_WORKER_CSP gives
it, read from lib.rs itself.  No other header: the app sets no CSP of its own.  (One exception, for
the tests only: requests to localhost, the probes' "other origin", come back
readable from anywhere: see end_headers.)

Port 0: the system picks a free port, and the server prints it (one line, on
stdout) once it is listening (web/test-port.mjs startServe)."""
import http.server, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")
LIB = open(os.path.join(HERE, "src-tauri", "src", "lib.rs"), encoding="utf-8").read()
m = re.search(r'const SHELL_WORKER_CSP: &str = "([^"]*)";', LIB)
if not m:
    sys.exit("app/serve-app.py: no SHELL_WORKER_CSP in app/src-tauri/src/lib.rs")
SHELL_WORKER_CSP = m.group(1)
args = [a for a in sys.argv[1:] if a != "--no-coi"]
COI = "--no-coi" not in sys.argv[1:]


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript"}

    def __init__(self, *a, **k):
        super().__init__(*a, directory=DIST, **k)

    def end_headers(self):
        if COI:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # (localhost, not the app's 127.0.0.1: the "other origin" of web/shell/test-panel-app.mjs's probes, served
        # as a permissive site elsewhere may be, readable from anywhere; so only the shell worker's policy refuses it)
        if self.headers.get("Host", "").split(":")[0] == "localhost":
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        # (lib.rs: the path, its query or fragment cut off, exactly)
        if re.split(r"[?#]", self.path, maxsplit=1)[0] == "/shell/worker-boot.js":
            self.send_header("Content-Security-Policy", SHELL_WORKER_CSP)
        super().end_headers()

    def log_message(self, *a):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", int(args[0]) if args else 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
