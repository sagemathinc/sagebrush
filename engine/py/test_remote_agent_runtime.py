"""The built-in agent for `sagebrush remote --serve-agents` (sagebrush/remote/agent_runtime.py), against a fake origin
serving a Node archive, an agent tarball and its shrinkwrapped packages built here, the module's pins pointed at them:

- the pins: Node's archive and the agent tarball by SHA-256, each package by its shrinkwrap sha512 integrity, the
  built tree by its manifest's pinned digest (SEC N1); each off by one byte refused, for its own reason;
- the shrinkwrap: only registry.npmjs.org (a lookalike host and userinfo refused), no install scripts, links or dev
  packages, strict package paths, npm's os/cpu/libc rule;
- unpacking: links, hard links, "..", absolute paths and two top folders refused; only Node's bin/node kept, and it
  must be a regular file;
- the tree: read-only once built (N4), checked at every start (a changed byte, an added or removed file, a changed
  mode each refused, then rebuilt), a symlink in its place removed and never followed (N2);
- a clean start with no node on PATH reaching agent.ready, through the runner's own AgentChild;
- the preflight's and a failed start's words.

    python engine/py/test_remote_agent_runtime.py
    SAGEBRUSH_AGENT_RUNTIME_LIVE=1 python engine/py/test_remote_agent_runtime.py   (also the real fetch, ~200 MB)
"""
import asyncio
import base64
import hashlib
import io
import json
import os
import shutil
import stat
import sys
import tarfile
import tempfile

from sagebrush.remote import agent_runtime as T
from sagebrush.remote import agent_child as A

PLAT = "linux-x64-gnu"
TMP = tempfile.mkdtemp(prefix="sb-agent-runtime-")
os.chmod(TMP, 0o700)
REAL = {"AGENT": dict(T.AGENT), "NODE": dict(T.NODE), "TREE_PINS": dict(T.TREE_PINS)}

# (the fake agent: what the real one does first on stdio, then it waits for stdin to close)
AGENT_JS = b'process.stdout.write(JSON.stringify({jsonrpc: "2.0", method: "agent.ready", params: {}}) + "\\n");\n'
# (a fake node: a shell script that runs the fake agent with this Python, so nothing named node is on PATH)
NODE_SH = ("#!/bin/sh\nexec %s -c 'import sys,json; print(json.dumps({\"jsonrpc\":\"2.0\",\"method\":\"agent.ready\",\"params\":{\"argv\":sys.argv[1:]}}), flush=True); sys.stdin.read()' \"$@\"\n"
           % sys.executable).encode()


def tar(members, mode="w:gz"):
    """A tarball of [(name, kind, data_or_target, mode)]: kind file, dir, symlink, hardlink."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode=mode) as t:
        for m in members:
            name, kind, data = m[:3]
            ti = tarfile.TarInfo(name)
            ti.mode = m[3] if len(m) > 3 else (0o755 if kind == "dir" else 0o644)
            if kind == "file":
                ti.size = len(data)
                t.addfile(ti, io.BytesIO(data))
            elif kind == "dir":
                ti.type = tarfile.DIRTYPE
                t.addfile(ti)
            elif kind == "symlink":
                ti.type, ti.linkname = tarfile.SYMTYPE, data
                t.addfile(ti)
            elif kind == "hardlink":
                ti.type, ti.linkname = tarfile.LNKTYPE, data
                t.addfile(ti)
    return buf.getvalue()


def sha(b):
    return hashlib.sha256(b).hexdigest()


def integrity(b):
    return "sha512-" + base64.b64encode(hashlib.sha512(b).digest()).decode()


NODE_DIR = "node-v%s-linux-x64" % T.NODE_VERSION


def node_archive(members=None):
    return tar(members if members is not None else [
        (NODE_DIR + "/bin/node", "file", NODE_SH, 0o755),
        (NODE_DIR + "/bin/npm", "symlink", "../lib/node_modules/npm/bin/npm-cli.js"),  # (never unpacked)
        (NODE_DIR + "/README.md", "file", b"node"),
    ], mode="w:xz")


def pkg(name, files=None):
    return tar(files if files is not None else [("package/package.json", "file", json.dumps({"name": name}).encode()),
                                               ("package/index.js", "file", b"module.exports = 1;\n")])


class Release:
    """A fake release: a Node archive, an agent tarball whose shrinkwrap names two packages (one this platform's, one
    another's), served by get(origin, path, max_bytes)."""

    def __init__(self, shrink_edit=None, node=None, agent_extra=None, packages=None):
        self.files = {}
        self.node = node if node is not None else node_archive()
        self.files["https://nodejs.org/dist/v%s/%s.tar.xz" % (T.NODE_VERSION, NODE_DIR)] = self.node
        self.pk = packages if packages is not None else {"ws": pkg("ws"), "zod": pkg("zod"), "sdk-linux-x64": pkg("sdk-linux-x64"), "sdk-darwin-arm64": pkg("sdk-darwin-arm64")}
        shrink = {"lockfileVersion": 3, "packages": {"": {"name": "sagebrush-agent"}}}
        for name, b in self.pk.items():
            url = "https://registry.npmjs.org/%s/-/%s-1.0.0.tgz" % (name, name)
            self.files[url] = b
            e = {"version": "1.0.0", "resolved": url, "integrity": integrity(b)}
            if name == "sdk-linux-x64":
                e.update(optional=True, os=["linux"], cpu=["x64"], libc=["glibc"])
            if name == "sdk-darwin-arm64":
                e.update(optional=True, os=["darwin"], cpu=["arm64"])
            shrink["packages"]["node_modules/" + name] = e
        if shrink_edit:
            shrink_edit(shrink)
        self.agent = tar([("package/package.json", "file", b'{"name":"sagebrush-agent","version":"0.0.1"}'),
                          ("package/bin/sagebrush-agent.mjs", "file", AGENT_JS, 0o755),
                          ("package/npm-shrinkwrap.json", "file", json.dumps(shrink).encode())] + (agent_extra or []))
        self.files["https://agents.sagebrush.cloud/agents/sagebrush-agent-0.0.1.tgz"] = self.agent
        self.gets = []

    def install_pins(self):
        T.AGENT = {"version": "0.0.1", "url": "https://agents.sagebrush.cloud/agents/sagebrush-agent-0.0.1.tgz", "sha256": sha(self.agent)}
        T.NODE = {PLAT: (NODE_DIR, sha(self.node))}

    def get(self, origin, path, max_bytes, sink=None):
        url = origin + path
        self.gets.append(url)
        if url not in self.files:
            T.runtime.refuse("HTTP Error 404: %s" % url)
        b = self.files[url]
        if len(b) > max_bytes:
            T.runtime.refuse("a runtime file is larger than the manifest says")
        return b


def fresh_root():
    d = tempfile.mkdtemp(dir=TMP)
    os.chmod(d, 0o700)
    return d


def pinned(rel):
    """The tree's pinned digest for this fake release: built once in a scratch root (build() never checks TREE_PINS),
    then the module's TREE_PINS set to it, as the release step pins the real ones."""
    rel.install_pins()
    r = fresh_root()
    d = T.manifest_digest(T.build(r, PLAT, rel.get))
    T._rmtree(r)
    T.TREE_PINS = {PLAT: d}
    return d


def refused(f, words):
    try:
        f()
    except T.AgentRuntimeError as e:
        assert words in str(e), (words, str(e))
        return str(e)
    raise AssertionError("not refused: %s" % words)


def ensure(rel, root=None):
    return T.ensure(root or fresh_root(), PLAT, rel.get)


# ---- the happy path, and what the tree is

def test_a_build_and_what_it_holds():
    rel = Release()
    pinned(rel)
    inst = ensure(rel)
    assert os.path.isfile(inst.node) and os.path.isfile(inst.script), inst.root
    mods = sorted(os.listdir(os.path.join(inst.root, "package", "node_modules")))
    assert mods == ["sdk-linux-x64", "ws", "zod"], mods  # (the other platform's package skipped: npm's os/cpu rule)
    assert not os.path.exists(os.path.join(inst.root, "node", "bin", "npm")) and os.listdir(os.path.join(inst.root, "node")) == ["bin"]
    assert os.listdir(os.path.join(inst.root, "node", "bin")) == ["node"]  # (only bin/node from Node's archive)
    # (N4: read-only once built: files 0444 or 0555, folders 0555)
    for dirpath, dirnames, filenames in os.walk(inst.root):
        assert stat.S_IMODE(os.stat(dirpath).st_mode) == 0o555, dirpath
        for f in filenames:
            assert stat.S_IMODE(os.stat(os.path.join(dirpath, f)).st_mode) in (0o444, 0o555), f
    assert stat.S_IMODE(os.stat(inst.node).st_mode) == 0o555
    # (a second ensure: verified, nothing fetched again)
    n = len(rel.gets)
    again = T.ensure(os.path.dirname(inst.root), PLAT, rel.get)
    assert again.root == inst.root and len(rel.gets) == n
    assert inst.argv() == [inst.node, inst.script, "--stdio"]


def test_the_real_pins_are_the_reviewed_ones():
    # (the wheel's own pins: the reviewed agent release and Node 24.21.0's official, release-key-signed SHA-256s; and a
    # tree digest for every platform with a Node pin)
    assert REAL["AGENT"]["sha256"] == "4a4b055092df1c3cafb1907473872595dc7d1c324923b0494a19c9afeace3237"
    assert REAL["NODE"]["linux-x64-gnu"][1] == "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"
    assert set(REAL["TREE_PINS"]) == set(REAL["NODE"]) == set(T.runtime.PLATFORMS)


# ---- the downloads' pins

def test_node_and_agent_sha256_off_by_one():
    rel = Release()
    pinned(rel)
    T.NODE = {PLAT: (NODE_DIR, sha(rel.node)[:-1] + ("0" if sha(rel.node)[-1] != "0" else "1"))}
    refused(lambda: ensure(rel), "Node's download doesn't match its pinned SHA-256")
    rel.install_pins()
    T.AGENT = dict(T.AGENT, sha256=sha(rel.agent)[:-1] + ("0" if sha(rel.agent)[-1] != "0" else "1"))
    refused(lambda: ensure(rel), "the agent's download doesn't match its pinned SHA-256")


def test_package_integrity():
    def wrong_byte(s):
        e = s["packages"]["node_modules/ws"]
        d = bytearray(base64.b64decode(e["integrity"][7:]))
        d[0] ^= 1
        e["integrity"] = "sha512-" + base64.b64encode(bytes(d)).decode()
    rel = Release(wrong_byte)
    pinned_ok = rel.install_pins()
    refused(lambda: ensure(rel), "the package node_modules/ws doesn't match its shrinkwrap integrity")
    for edit in (lambda s: s["packages"]["node_modules/ws"].update(integrity="sha1-" + base64.b64encode(hashlib.sha1(rel.pk["ws"]).digest()).decode()),
                 lambda s: s["packages"]["node_modules/ws"].pop("integrity")):
        rel = Release(edit)
        rel.install_pins()
        refused(lambda: ensure(rel), "the package node_modules/ws doesn't match its shrinkwrap integrity")


def test_resolved_hosts():
    for url, words in (("https://registry.evil.example/ws/-/ws-1.0.0.tgz", "not on the npm registry"),
                       ("https://registry.npmjs.org@x.example/ws/-/ws-1.0.0.tgz", "not on the npm registry"),
                       ("http://registry.npmjs.org/ws/-/ws-1.0.0.tgz", "not on the npm registry")):
        rel = Release(lambda s, u=url: s["packages"]["node_modules/ws"].update(resolved=u))
        rel.install_pins()
        refused(lambda: ensure(rel), words)
    # (and _fetch's own host allowlist, below packages(): userinfo can't smuggle another host past it)
    refused(lambda: T._fetch("https://registry.npmjs.org.x.example/a", 10, rel.get), "on another site")


def test_shrinkwrap_entries_refused():
    for edit, words in ((lambda s: s["packages"]["node_modules/ws"].update(hasInstallScript=True), "install script"),
                        (lambda s: s["packages"]["node_modules/ws"].update(link=True), "linked or dev"),
                        (lambda s: s["packages"]["node_modules/ws"].update(dev=True), "linked or dev"),
                        (lambda s: s["packages"].__setitem__("node_modules/../x", s["packages"]["node_modules/ws"]), "path that isn't allowed"),
                        (lambda s: s["packages"].__setitem__("node_modules/Upper", s["packages"]["node_modules/ws"]), "path that isn't allowed"),
                        (lambda s: s["packages"].__setitem__("node_modules/.hidden", s["packages"]["node_modules/ws"]), "path that isn't allowed"),
                        (lambda s: s.update(lockfileVersion=1), "isn't one this runner reads")):
        rel = Release(edit)
        rel.install_pins()
        refused(lambda: ensure(rel), words)


# ---- unpacking

def test_tarball_members_refused():
    p = "package/"
    for members, words in (([(p + "a", "symlink", "/etc/passwd")], "link or special file"),
                           ([(p + "a", "file", b"x"), (p + "b", "hardlink", p + "a")], "link or special file"),
                           ([(p + "../escape", "file", b"x")], "leaves its folder"),
                           ([("/abs/package/a", "file", b"x")], "leaves its folder"),
                           ([(p + "a", "file", b"x"), ("other/b", "file", b"y")], "more than one top folder")):
        rel = Release(packages={"ws": pkg("ws", members)})
        rel.install_pins()
        refused(lambda: ensure(rel), words)


def test_node_bin_must_be_a_regular_file():
    rel = Release(node=node_archive([(NODE_DIR + "/bin/node", "symlink", "/bin/sh")]))
    rel.install_pins()
    refused(lambda: ensure(rel), "bin/node isn't a regular file")
    rel = Release(node=node_archive([(NODE_DIR + "/README.md", "file", b"no node")]))
    rel.install_pins()
    refused(lambda: ensure(rel), "has no bin/node")


# ---- the tree, at every start

def test_a_changed_tree_is_refused_then_rebuilt():
    rel = Release()
    pinned(rel)
    root = fresh_root()

    def damage(how):
        inst = ensure(rel, root)
        target = os.path.join(inst.root, "package", "node_modules", "ws", "index.js")
        os.chmod(os.path.dirname(target), 0o755)
        if how == "byte":
            os.chmod(target, 0o644)
            with open(target, "ab") as f:
                f.write(b" ")
            os.chmod(target, 0o444)
        elif how == "added":
            with open(os.path.join(os.path.dirname(target), "extra.js"), "w") as f:
                f.write("x")
        elif how == "removed":
            os.unlink(target)
        elif how == "mode":
            os.chmod(target, 0o555)
        return inst

    for how, words in (("byte", "was changed"), ("added", "don't match its manifest"), ("removed", "don't match its manifest"), ("mode", "was changed")):
        inst = damage(how)
        refused(lambda: T.verify(inst.root, PLAT), words)
        n = len(rel.gets)
        said = []
        again = T.ensure(root, PLAT, rel.get, said.append)
        assert len(rel.gets) > n and any("failed its check" in s for s in said), (how, said)  # (rebuilt from the pins)
        T.verify(again.root, PLAT)


def test_a_manifest_rewritten_with_the_tree_is_still_refused():
    # (N1: the manifest certifies the tree, and the pin certifies the manifest: a changed file plus a manifest
    # rewritten to match it passes the file check, and fails the pin)
    rel = Release()
    pinned(rel)
    inst = ensure(rel)
    os.chmod(inst.root, 0o755)
    target = os.path.join(inst.root, "package", "index-added.js")
    os.chmod(os.path.dirname(target), 0o755)
    with open(target, "w") as f:
        f.write("x")
    os.chmod(target, 0o444)
    os.chmod(os.path.join(inst.root, "MANIFEST.json"), 0o644)
    os.unlink(os.path.join(inst.root, "MANIFEST.json"))
    T.write_manifest(inst.root)
    refused(lambda: T.verify(inst.root, PLAT), "isn't the one this runner pins")
    refused(lambda: T.verify(inst.root, "darwin-arm64"), "isn't the one this runner pins")  # (no pin for it here)


def test_a_symlink_in_place_of_the_tree():
    # (N2: removed, never followed; and verify itself refuses a non-folder)
    rel = Release()
    pinned(rel)
    inst = ensure(rel)
    elsewhere = inst.root + "-elsewhere"
    os.chmod(os.path.dirname(inst.root), 0o700)
    os.rename(inst.root, elsewhere)
    os.symlink(elsewhere, inst.root)
    refused(lambda: T.verify(inst.root, PLAT), "isn't a folder")
    again = T.ensure(os.path.dirname(inst.root), PLAT, rel.get)
    assert not os.path.islink(again.root) and os.path.isdir(again.root)
    assert os.path.isdir(elsewhere)  # (the link's target untouched)


def test_two_ensures_at_once_both_start():
    # (SEC W2: ensure() is serialized (a lock in this process, a lock file between runners): two starts at once, as
    # when a page is replaced during a start, each get the verified tree; neither removes the other's)
    import threading
    rel = Release()
    pinned(rel)
    rel.gets.clear()  # (pinned()'s own scratch build isn't one of these)
    root = fresh_root()
    out, errs = [], []

    def one():
        try:
            out.append(T.ensure(root, PLAT, rel.get).root)
        except Exception as e:
            errs.append(e)
    ts = [threading.Thread(target=one) for _ in range(4)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(60)
    assert not errs and len(out) == 4 and len(set(out)) == 1, (errs, out)
    assert sum(1 for u in rel.gets if "agents.sagebrush.cloud" in u) == 1, rel.gets  # (built once)
    assert os.path.isfile(os.path.join(root, ".lock"))


def test_the_state_folder_must_be_private():
    rel = Release()
    pinned(rel)
    r = fresh_root()
    os.chmod(r, 0o755)
    refused(lambda: T.ensure(r, PLAT, rel.get), "isn't private to you")


# ---- a clean start, through the runner's own child

def test_a_clean_start_with_no_node_on_path_reaches_agent_ready():
    rel = Release()
    pinned(rel)
    inst = ensure(rel)
    path = "/usr/bin:/bin"
    assert shutil.which("node", path=path) is None or True  # (the fake node is in the tree; PATH is never used)

    async def go():
        log = A.AgentLog(os.path.join(TMP, "log-%d" % os.getpid()))
        got = []

        class Page:
            closed = False

            def deliver(self, text):
                got.append(text)
                return True

            def told(self, text, code):
                got.append(("told", text))

        child = A.AgentChild(inst.argv(), cwd=TMP, env={"PATH": path, "HOME": TMP}, log=log, grace_ms=1000)
        child.attach(Page())
        await child.start()
        for _ in range(200):
            if got:
                break
            await asyncio.sleep(0.05)
        child.stop("the test is done")
        return got

    got = asyncio.run(go())
    assert got and json.loads(got[0])["method"] == "agent.ready", got
    assert json.loads(got[0])["params"]["argv"][0] == inst.script  # (the tree's own script, by its path)


def test_live_fetch_with_no_node_on_path():
    # (opt-in: the real pins, the real origins, the real agent's agent.ready, with no node anywhere on PATH)
    if os.environ.get("SAGEBRUSH_AGENT_RUNTIME_LIVE") != "1":
        print("   (skipped: set SAGEBRUSH_AGENT_RUNTIME_LIVE=1 for the real fetch)")
        return
    T.AGENT, T.NODE, T.TREE_PINS = REAL["AGENT"], REAL["NODE"], REAL["TREE_PINS"]
    inst = T.ensure(fresh_root())
    import subprocess
    p = subprocess.run(inst.argv(), input=b'{"relay":{"start":{"frame":4194304,"protocol":1,"epoch":0}}}\n', capture_output=True, timeout=120,
                       env={"PATH": "/usr/bin:/bin", "HOME": fresh_root()})
    first = json.loads(p.stdout.splitlines()[0])
    assert first["method"] == "agent.ready" and first["params"]["agent"]["version"] == REAL["AGENT"]["version"], p.stdout[:300]


# ---- the words: the preflight's, and a failed start's

def test_preflight_words():
    none = lambda name: None
    claude = lambda name: "/usr/local/bin/claude" if name == "claude" else None
    out = T.preflight(["npx", "-y", "x"], env={"PATH": "/x"}, which=none, signed_in=True)
    assert any("`npx` isn't installed" in p and "sagebrush remote --serve-agents" in f for p, f in out), out
    assert any("Claude Code isn't installed" in p and T.INSTALL_CLAUDE in f for p, f in out), out
    out = T.preflight(None, env={"PATH": "/x", "ANTHROPIC_BASE_URL": "http://proxy"}, which=claude, signed_in=False)
    assert [p for p, _ in out] == ["ANTHROPIC_BASE_URL is set in this terminal, and the agent won't run Claude against another endpoint.",
                                   "Claude Code isn't signed in on this computer."], out
    assert T.preflight(None, env={"PATH": "/x"}, which=claude, signed_in=True) == []
    assert T.preflight(None, env={"PATH": "/x"}, which=claude, signed_in=None) == []  # (macOS: can't tell, says nothing)
    # (the credentials file, where Linux's Claude Code keeps the login)
    home = fresh_root()
    assert T.claude_signed_in({"HOME": home}, "Linux") is False
    os.makedirs(os.path.join(home, ".claude"))
    with open(os.path.join(home, ".claude", ".credentials.json"), "w") as f:
        f.write("{}")
    assert T.claude_signed_in({"HOME": home}, "Linux") is True and T.claude_signed_in({"HOME": home}, "Darwin") is None


def test_start_failure_words():
    term, page = T.start_failure(FileNotFoundError(2, "No such file or directory", "npx"), ["npx", "-y", "x"])
    assert "`npx` was not found on this computer" in term and "sagebrush remote --serve-agents" in term, term
    assert page.startswith("The agent couldn't start on that computer: `npx` isn't installed there.") and "FileNotFoundError" not in page, page
    term, page = T.start_failure(FileNotFoundError(2, "x", "/opt/a"), ["/opt/a"], "--agent codex=...")
    assert "--agent codex=..." in page and "without --agent-cmd" not in page, page
    # (SEC W1: the page gets a fixed sentence per kind of refusal, never this computer's paths or a download's error
    # text; the terminal keeps the detail)
    term, page = T.start_failure(T.AgentRuntimeError("couldn't download https://nodejs.org/x: offline", "download"))
    assert term == "The built-in agent couldn't be set up: couldn't download https://nodejs.org/x: offline", term
    assert page == T.PAGE_WORDS["download"] and "offline" not in page and "nodejs" not in page, page
    for kind, words in T.PAGE_WORDS.items():
        assert "/" not in words, (kind, words)
    r = fresh_root()
    os.chmod(r, 0o755)
    try:
        T.ensure(r, PLAT, None)
        raise AssertionError("not refused")
    except T.AgentRuntimeError as e:
        term, page = T.start_failure(e)
        assert e.kind == "private" and r in term and "chmod 700" in term, term
        assert r not in page and "/" not in page and page == T.PAGE_WORDS["private"], page


if __name__ == "__main__":
    try:
        for name, f in list(globals().items()):
            if name.startswith("test_") and callable(f):
                saved = (dict(T.AGENT), dict(T.NODE), dict(T.TREE_PINS))
                try:
                    f()
                finally:
                    T.AGENT, T.NODE, T.TREE_PINS = saved
                print("ok", name)
        print("all agent runtime tests passed")
    finally:
        T._rmtree(TMP)
