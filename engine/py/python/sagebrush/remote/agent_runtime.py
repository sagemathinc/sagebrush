"""The built-in agent for `sagebrush remote --serve-agents`: the reviewed sagebrush-agent release and a Node to run it,
fetched and verified by the runner itself, so the person installs nothing but Claude Code.

What is fetched, every byte pinned before it is used:
  - Node: the official build for this platform from nodejs.org, the archive's SHA-256 pinned below (from the release's
    SHASUMS256.txt); only its bin/node is kept;
  - the agent: the release tarball from agents.sagebrush.cloud, its SHA-256 pinned below (the reviewed release);
  - the agent's dependencies: exactly its npm-shrinkwrap.json's packages for this platform, each tarball from its
    `resolved` URL on registry.npmjs.org and checked against its sha512 `integrity` before it is unpacked. No package
    manager runs and no install script runs (the shrinkwrap has none; one that names one is refused).

Unpacking: regular files and folders only (a link, a device or anything else is refused), every path relative and
inside its package, a file's mode 0755 if the archive gives it an execute bit, else 0644.

The tree is built in a private staging folder, every file's SHA-256 written to MANIFEST.json, and renamed into place in
one step. Before each start the tree is checked against MANIFEST.json (no file missing, changed or added; no link), and
a tree that fails is refused in words, never run; `ensure` builds it again from the pinned sources.

The state folder: $XDG_STATE_HOME/sagebrush/remote/agent (default ~/.local/state/...), 0700, owned by this user.
"""

import base64
import hashlib
import io
import json
import os
import re
import shutil
import stat
import tarfile
import tempfile
import threading

from . import runtime

_LOCK = threading.Lock()  # (one ensure at a time in this process; the state folder's lock file, between runners)

AGENT = {
    "version": "0.8.18",
    "url": "https://agents.sagebrush.cloud/agents/sagebrush-agent-0.8.18.tgz",
    "sha256": "4a4b055092df1c3cafb1907473872595dc7d1c324923b0494a19c9afeace3237",
}
NODE_VERSION = "24.21.0"
# (nodejs.org/dist/v24.21.0/SHASUMS256.txt)
NODE = {
    "linux-x64-gnu": ("node-v24.21.0-linux-x64", "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"),
    "linux-arm64-gnu": ("node-v24.21.0-linux-arm64", "6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2"),
    "darwin-arm64": ("node-v24.21.0-darwin-arm64", "6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe"),
    "darwin-x64": ("node-v24.21.0-darwin-x64", "0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299"),
}
# (each platform's tree, as ensure() builds it from the pins above, is a pure function of those bytes: the SHA-256 of
# its MANIFEST.json, computed once at release by building all four on Linux (nothing runs), is pinned here; verify()
# checks it before trusting the manifest's file list, so a tree is checked against something outside itself)
TREE_PINS = {
    "linux-x64-gnu": "cfda345569b8b953469ce595b7e070ebd442f9ccd132a3ae12fef5651fe7eddb",
    "linux-arm64-gnu": "498e9c9cc85bf52fd15517cc454adfce704668719dd55dbc165341185402168e",
    "darwin-arm64": "92ef8b90c16d0b842644825e501b4ecf1fd949459b723659553f86f0b0dae97c",
    "darwin-x64": "b6bcfe617af3c85deca8b6a3324ee135e22dd22e1543653e3a217acf99124eaf",
}
NODE_ORIGIN = "https://nodejs.org"
AGENT_ORIGIN = "https://agents.sagebrush.cloud"
NPM_ORIGIN = "https://registry.npmjs.org"
# (npm's platform words for this runner's platform keys: a shrinkwrap entry with os, cpu or libc is installed only
# where every one it names matches)
_NPM_PLATFORM = {
    "linux-x64-gnu": ("linux", "x64", "glibc"),
    "linux-arm64-gnu": ("linux", "arm64", "glibc"),
    "darwin-arm64": ("darwin", "arm64", None),
    "darwin-x64": ("darwin", "x64", None),
}
LIMITS = {
    "fileBytes": runtime.LIMITS["fileBytes"],  # (one download; the largest, the SDK's Claude Code package, is ~175 MB)
    "packages": 512,                           # (the shrinkwrap's entries; 0.8.18 has 113)
    "files": 50000,                            # (files in the whole tree)
    "treeBytes": 2 * 1024 * 1024 * 1024,       # (the unpacked tree)
}
_NAME = re.compile(r"(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*\Z")
_KEY = re.compile(r"(node_modules/(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*)(/node_modules/(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*)*\Z")


class AgentRuntimeError(Exception):
    """The built-in agent can't be fetched, verified or started: the words for this computer's terminal (str(e)), and
    its kind (download, check, private, platform), which alone decides the page's fixed sentence: a remote page never
    gets this computer's paths or a download's error text."""

    def __init__(self, msg, kind="check"):
        super().__init__(msg)
        self.kind = kind


def _refuse(msg, kind="check"):
    raise AgentRuntimeError(msg, kind)


def state_dir():
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "sagebrush", "remote", "agent")


def tree_name(plat):
    return "sagebrush-agent-%s-node-%s-%s" % (AGENT["version"], NODE_VERSION, plat)


class Installed:
    """A verified tree: the command that starts the agent on stdio, and where it lives."""

    def __init__(self, root):
        self.root = root
        self.node = os.path.join(root, "node", "bin", "node")
        self.script = os.path.join(root, "package", "bin", "sagebrush-agent.mjs")

    def argv(self):
        return [self.node, self.script, "--stdio"]


# ---- fetching

def _fetch(url, max_bytes, get=None):
    """The bytes at an https URL on one of the three origins (same-origin redirects only), at most max_bytes."""
    parts = url.split("/", 3)
    if len(parts) < 4 or parts[0] != "https:" or parts[1] != "":
        _refuse("the built-in agent names a URL that isn't https: %s" % url)
    origin = "https://" + parts[2]
    if origin not in (NODE_ORIGIN, AGENT_ORIGIN, NPM_ORIGIN):
        _refuse("the built-in agent names a URL on another site: %s" % url)
    try:
        return (get or runtime._get)(origin, "/" + parts[3], max_bytes)
    except runtime.RuntimeError_ as e:
        _refuse("couldn't download %s: %s" % (url, e), "download")


def _sha256_hex(b):
    return hashlib.sha256(b).hexdigest()


def _integrity_ok(b, integrity):
    if not isinstance(integrity, str) or not integrity.startswith("sha512-"):
        return False
    try:
        want = base64.b64decode(integrity[len("sha512-"):], validate=True)
    except (ValueError, TypeError):
        return False
    return len(want) == 64 and hashlib.sha512(b).digest() == want


# ---- unpacking

def _unpack(data, dest, strip_top, what, only=None, counter=None):
    """A tarball's regular files and folders into dest (which must not exist), each path checked; the first path
    component stripped when strip_top (npm's package/ folder, whatever its name, the same for every member). only:
    the one member (after stripping) to keep, everything else skipped. Returns the files written."""
    os.mkdir(dest, 0o700)
    written, top = [], None
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as t:
            for ti in t:
                name = ti.name
                while name.startswith("./"):
                    name = name[2:]
                name = name.rstrip("/")
                if not name:
                    continue
                parts = name.split("/")
                if name.startswith("/") or any(p in ("", ".", "..") for p in parts) or "\\" in name:
                    _refuse("%s has a path that leaves its folder: %r" % (what, ti.name))
                if strip_top:
                    if top is None:
                        top = parts[0]
                    elif parts[0] != top:
                        _refuse("%s has more than one top folder" % what)
                    parts = parts[1:]
                    if not parts:
                        continue
                rel = "/".join(parts)
                if only is not None and rel != only:
                    continue
                if ti.isdir():
                    os.makedirs(os.path.join(dest, *parts), mode=0o755, exist_ok=True)
                    continue
                if not ti.isreg():
                    if only is not None:
                        _refuse("%s's %s isn't a regular file" % (what, only))
                    _refuse("%s has a link or special file: %s" % (what, rel))
                if counter is not None:
                    counter["files"] += 1
                    counter["bytes"] += ti.size
                    if counter["files"] > LIMITS["files"] or counter["bytes"] > LIMITS["treeBytes"]:
                        _refuse("the built-in agent is larger than its limits")
                parent = os.path.join(dest, *parts[:-1])
                os.makedirs(parent, mode=0o755, exist_ok=True)
                path = os.path.join(parent, parts[-1])
                f = t.extractfile(ti)
                mode = 0o555 if ti.mode & 0o111 else 0o444  # (read-only once built: N4)
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                try:
                    while True:
                        chunk = f.read(1 << 20)
                        if not chunk:
                            break
                        os.write(fd, chunk)
                    os.fchmod(fd, mode)
                finally:
                    os.close(fd)
                written.append(rel)
    except (tarfile.TarError, EOFError, OSError) as e:
        if isinstance(e, AgentRuntimeError):
            raise
        _refuse("%s can't be unpacked (%s)" % (what, e))
    if only is not None and only not in written:
        _refuse("%s has no %s" % (what, only))
    return written


def _wanted(entry, plat):
    """Whether a shrinkwrap entry is installed on this platform (npm's os/cpu/libc rule)."""
    osn, cpu, libc = _NPM_PLATFORM[plat]
    for field, mine in (("os", osn), ("cpu", cpu), ("libc", libc)):
        v = entry.get(field)
        if v is None:
            continue
        if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
            _refuse("the agent's shrinkwrap has a malformed %s" % field)
        allowed = [x for x in v if not x.startswith("!")]
        denied = [x[1:] for x in v if x.startswith("!")]
        if mine is None:
            if allowed:
                return False
            continue
        if mine in denied or (allowed and mine not in allowed):
            return False
    return True


def packages(shrinkwrap, plat):
    """The shrinkwrap's packages for this platform: [(key, resolved, integrity)], each checked."""
    if not isinstance(shrinkwrap, dict) or shrinkwrap.get("lockfileVersion") not in (2, 3) or not isinstance(shrinkwrap.get("packages"), dict):
        _refuse("the agent's shrinkwrap isn't one this runner reads")
    pk = shrinkwrap["packages"]
    if len(pk) > LIMITS["packages"]:
        _refuse("the agent's shrinkwrap has more packages than its limit")
    out = []
    for key, e in pk.items():
        if key == "":
            continue
        if not isinstance(e, dict) or not isinstance(key, str) or not _KEY.match(key):
            _refuse("the agent's shrinkwrap names a package path that isn't allowed: %r" % (key,))
        if e.get("link") or e.get("dev"):
            _refuse("the agent's shrinkwrap has a linked or dev package: %s" % key)
        if e.get("hasInstallScript"):
            _refuse("the agent's shrinkwrap has a package with an install script: %s" % key)
        if not _wanted(e, plat):
            continue
        r = e.get("resolved")
        if not isinstance(r, str) or not r.startswith(NPM_ORIGIN + "/"):
            _refuse("the agent's shrinkwrap names a package not on the npm registry: %s" % key)
        out.append((key, r, e.get("integrity")))
    return out


# ---- the manifest and verification

def _hash_file(path):
    h = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        while True:
            b = os.read(fd, 1 << 20)
            if not b:
                break
            h.update(b)
        return h.hexdigest(), stat.S_IMODE(os.fstat(fd).st_mode)
    finally:
        os.close(fd)


def _walk(root):
    """Every regular file under root, as a sorted list of '/' paths; a link or anything else is refused."""
    files = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        for d in dirnames:
            if os.path.islink(os.path.join(dirpath, d)):
                _refuse("the built-in agent's folder has a link: %s" % os.path.join(dirpath, d))
        for f in filenames:
            p = os.path.join(dirpath, f)
            st = os.lstat(p)
            if not stat.S_ISREG(st.st_mode):
                _refuse("the built-in agent's folder has a link or special file: %s" % p)
            files.append(os.path.relpath(p, root).replace(os.sep, "/"))
    return sorted(files)


def write_manifest(root):
    entries = []
    for rel in _walk(root):
        if rel == "MANIFEST.json":
            continue
        sha, mode = _hash_file(os.path.join(root, *rel.split("/")))
        entries.append({"path": rel, "sha256": sha, "mode": mode})
    body = {"agent": AGENT["version"], "agent_sha256": AGENT["sha256"], "node": NODE_VERSION, "files": entries}
    with open(os.path.join(root, "MANIFEST.json"), "x") as f:
        json.dump(body, f, sort_keys=True, separators=(",", ":"))
    os.chmod(os.path.join(root, "MANIFEST.json"), 0o444)


def manifest_digest(root):
    with open(os.path.join(root, "MANIFEST.json"), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def _seal(root):
    """Every folder of the built tree read-only (N4): an agent writing into its own code by accident gets EACCES."""
    for dirpath, dirnames, _ in os.walk(root, topdown=False):
        os.chmod(dirpath, 0o555)


def _rmtree(path):
    """A tree removed, read-only folders included; a link (or any non-folder) at path is unlinked, never followed."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(st.st_mode):
        os.unlink(path)
        return
    for dirpath, dirnames, _ in os.walk(path):
        for d in [dirpath] + [os.path.join(dirpath, x) for x in dirnames]:
            if not os.path.islink(d):
                try:
                    os.chmod(d, 0o700)
                except OSError:
                    pass
    shutil.rmtree(path, ignore_errors=True)


def verify(root, plat, pins=None):
    """The tree against its MANIFEST.json, and that manifest against this platform's pinned digest (N1): the pins it
    was built from are this runner's, and every file is there, unchanged, with nothing added. Refused in words
    otherwise."""
    pins = TREE_PINS if pins is None else pins
    st = os.lstat(root)
    if not stat.S_ISDIR(st.st_mode):
        _refuse("the built-in agent's folder isn't a folder")
    try:
        fd = os.open(os.path.join(root, "MANIFEST.json"), os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as f:
            raw = f.read()
        m = json.loads(raw)
    except (OSError, ValueError):
        _refuse("the built-in agent's MANIFEST.json is missing or unreadable")
    if plat not in pins or hashlib.sha256(raw).hexdigest() != pins[plat]:
        _refuse("the built-in agent's manifest isn't the one this runner pins for %s" % plat)
    if not isinstance(m, dict) or m.get("agent") != AGENT["version"] or m.get("agent_sha256") != AGENT["sha256"] or m.get("node") != NODE_VERSION:
        _refuse("the built-in agent on disk isn't the version this runner pins")
    want = {e["path"]: e for e in m.get("files", []) if isinstance(e, dict) and isinstance(e.get("path"), str)}
    have = [p for p in _walk(root) if p != "MANIFEST.json"]
    if set(have) != set(want):
        _refuse("the built-in agent's files don't match its manifest (a file is missing or was added)")
    for rel in have:
        sha, mode = _hash_file(os.path.join(root, *rel.split("/")))
        if sha != want[rel].get("sha256") or mode != want[rel].get("mode"):
            _refuse("the built-in agent's file %s was changed" % rel)
    return Installed(root)


# ---- install

def _private(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) & 0o077:
        _refuse("the folder %s isn't private to you (owner and mode 0700 needed): chmod 700 %s" % (path, path), "private")
    return path


def ensure(root=None, plat=None, get=None, say=None, pins=None):
    """The verified built-in agent: the tree on disk if it verifies, else built again from the pinned sources.
    say(text): progress lines for the terminal."""
    say = say or (lambda s: None)
    try:
        plat = plat or runtime.this_platform()
    except runtime.RuntimeError_ as e:
        _refuse(str(e), "platform")
    if plat not in NODE:
        _refuse("the built-in agent isn't available for this machine (%s)" % plat, "platform")
    root = _private(root or state_dir())
    with _LOCK:
        lock = os.open(os.path.join(root, ".lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
            return _ensure_locked(root, plat, get, say, pins)
        finally:
            os.close(lock)


def _ensure_locked(root, plat, get, say, pins):
    final = os.path.join(root, tree_name(plat))
    if os.path.lexists(final):
        # (N2: a link or a file in its place is removed, never followed; a folder that fails is rebuilt, never run)
        if not stat.S_ISDIR(os.lstat(final).st_mode):
            os.unlink(final)
        else:
            try:
                return verify(final, plat, pins)
            except AgentRuntimeError as e:
                say("The built-in agent on disk failed its check (%s); fetching it again." % e)
                _rmtree(final)
    build(root, plat, get, say)
    say("The built-in agent is ready.")
    return verify(final, plat, pins)


def build(root, plat, get=None, say=None):
    """The tree built from the pins into root/<tree_name> (one rename), unverified against TREE_PINS: ensure()'s
    work, and the release step's that computes those pins (all four platforms build on any machine; nothing runs)."""
    say = say or (lambda s: None)
    final = os.path.join(root, tree_name(plat))
    stage = tempfile.mkdtemp(prefix=".staging-", dir=root)
    try:
        tree = os.path.join(stage, "tree")
        os.mkdir(tree, 0o700)
        name, sha = NODE[plat]
        say("Fetching Node %s for the built-in agent…" % NODE_VERSION)
        data = _fetch("%s/dist/v%s/%s.tar.xz" % (NODE_ORIGIN, NODE_VERSION, name), LIMITS["fileBytes"], get)
        if _sha256_hex(data) != sha:
            _refuse("Node's download doesn't match its pinned SHA-256")
        _unpack(data, os.path.join(tree, "node"), True, "Node's archive", only="bin/node")
        os.chmod(os.path.join(tree, "node", "bin", "node"), 0o555)
        del data
        say("Fetching sagebrush-agent %s…" % AGENT["version"])
        data = _fetch(AGENT["url"], LIMITS["fileBytes"], get)
        if _sha256_hex(data) != AGENT["sha256"]:
            _refuse("the agent's download doesn't match its pinned SHA-256")
        counter = {"files": 0, "bytes": 0}
        _unpack(data, os.path.join(tree, "package"), True, "the agent's tarball", counter=counter)
        del data
        try:
            with open(os.path.join(tree, "package", "npm-shrinkwrap.json")) as f:
                shrink = json.load(f)
        except (OSError, ValueError):
            _refuse("the agent's tarball has no readable npm-shrinkwrap.json")
        pk = packages(shrink, plat)
        say("Fetching the agent's %d packages (once; about 200 MB)…" % len(pk))
        for key, url, integrity in pk:
            b = _fetch(url, LIMITS["fileBytes"], get)
            if not _integrity_ok(b, integrity):
                _refuse("the package %s doesn't match its shrinkwrap integrity" % key)
            dest = os.path.join(tree, "package", *key.split("/"))
            if os.path.lexists(dest):
                _refuse("the agent's shrinkwrap names %s twice" % key)
            os.makedirs(os.path.dirname(dest), 0o755, exist_ok=True)
            _unpack(b, dest, True, "the package %s" % key, counter=counter)
        write_manifest(tree)
        try:
            os.rename(tree, final)
        except OSError:
            if not os.path.lexists(final):
                raise
            # (another runner finished first: use its tree, once it verifies)
            return final
        # (folders read-only after the rename, which needs the moved folder writable for its ".." entry)
        _seal(final)
        return final
    finally:
        _rmtree(stage)


# ---- what a person needs on this computer, in words

INSTALL_CLAUDE = "curl -fsSL https://claude.ai/install.sh | bash"


def claude_signed_in(env=None, system=None):
    """True or False where it can be told from the files (Linux: Claude Code's credentials file), None where it can't
    (macOS keeps the login in the Keychain)."""
    env = os.environ if env is None else env
    import platform as _p
    if (system or _p.system()) == "Darwin":
        return None
    base = env.get("CLAUDE_CONFIG_DIR") or os.path.join(env.get("HOME") or os.path.expanduser("~"), ".claude")
    try:
        return os.path.getsize(os.path.join(base, ".credentials.json")) > 0
    except OSError:
        return False


_CHECK = object()


def preflight(cmd=None, env=None, which=None, signed_in=_CHECK):
    """What the agent will need here and isn't, each as (problem, the one command or step that fixes it). cmd: the
    --agent-cmd's argv, or None for the built-in agent."""
    env = os.environ if env is None else env
    which = which or (lambda name: shutil.which(name, path=env.get("PATH")))
    out = []
    if cmd is not None and not (os.path.isabs(cmd[0]) and os.access(cmd[0], os.X_OK)) and which(cmd[0]) is None:
        out.append(("The agent's command `%s` isn't installed on this computer (it isn't on PATH)." % cmd[0],
                    "Start the runner without --agent-cmd to use the built-in agent, which needs no Node: "
                    "sagebrush remote --serve-agents"))
    if env.get("ANTHROPIC_BASE_URL"):
        out.append(("ANTHROPIC_BASE_URL is set in this terminal, and the agent won't run Claude against another endpoint.",
                    "unset ANTHROPIC_BASE_URL   (then start the runner again)"))
    if which("claude") is None:
        out.append(("Claude Code isn't installed on this computer (no `claude` on PATH).",
                    "%s   (then run `claude` once and sign in)" % INSTALL_CLAUDE))
    else:
        s = claude_signed_in(env) if signed_in is _CHECK else signed_in
        if s is False:
            out.append(("Claude Code isn't signed in on this computer.", "claude   (then follow its sign-in, or type /login)"))
    return out


# (the page's fixed sentence per kind of refusal: nothing of this computer's in it; the terminal has the detail)
PAGE_WORDS = {
    "download": "The agent couldn't start on that computer: the built-in agent couldn't be downloaded there. Check that computer's internet connection; the runner's terminal there says more.",
    "check": "The agent couldn't start on that computer: the built-in agent failed its check there. The runner's terminal there says more.",
    "private": "The agent couldn't start on that computer: the runner's state folder there isn't private to its user. The runner's terminal there says how to fix it.",
    "platform": "The agent couldn't start on that computer: the built-in agent isn't available for that kind of computer yet. Start the runner there with --agent-cmd and your own agent's command.",
}


def start_failure(e, cmd=None, how="--agent-cmd"):
    """(the terminal's line, the page's words) for an agent that couldn't start. cmd: the kind's own argv, or None for
    the built-in agent; how: that kind's option (--agent-cmd, or --agent NAME=...)."""
    if isinstance(e, AgentRuntimeError):
        return ("The built-in agent couldn't be set up: %s" % e, PAGE_WORDS.get(e.kind, PAGE_WORDS["check"]))
    fix = ("start the runner again without --agent-cmd to use the built-in agent: sagebrush remote --serve-agents"
           if how == "--agent-cmd" else "fix the runner's %s command, or start it with just --serve-agents for the built-in agent" % how)
    if isinstance(e, FileNotFoundError) and cmd is not None:
        return ("The agent couldn't start: `%s` was not found on this computer (%s). To fix it, %s" % (cmd[0], e, fix),
                "The agent couldn't start on that computer: `%s` isn't installed there. On that computer, %s."
                % (os.path.basename(cmd[0]), fix))
    if isinstance(e, PermissionError):
        return ("The agent couldn't start: permission denied (%s). To fix it, %s" % (e, fix),
                "The agent couldn't start on that computer: its command isn't allowed to run there. On that computer, %s." % fix)
    return ("The agent couldn't start: %s" % e,
            "The agent couldn't start on that computer (%s). The runner's terminal there says more." % type(e).__name__)
