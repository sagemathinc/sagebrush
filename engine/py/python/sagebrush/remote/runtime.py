"""The remote's runtime: Node, the engine bundle and (later) the native addon, fetched, verified and activated by the
host itself (remote r3.7, design/remote-r3.md amendment B, with SEC's bundle conditions and B1; step P2c-1).

  - The manifest for this wheel's exact version is pinned by the sha256 of its canonical bytes, compiled in here
    (MANIFEST_PINS, written by the release); a digest the manifest declares for itself is never trusted.  It names
    exactly this version and a closed, duplicate-free set of strict relative paths, each with its size and sha256.
  - It is fetched only from the compiled-in HTTPS origin (RUNTIME_ORIGIN), with deadlines, byte caps, and redirects
    only within that origin.
  - Install: a fresh owner-only staging directory in the host's 0700 state folder; Node's archive verified, then only
    the members the manifest says to extract (bin/node) written, every archive member checked against the manifest's
    expected list first (an unexpected one refuses the archive; an expected one not extracted is skipped, never
    written); the bundle's files each written by exclusive, no-follow creates relative to held directory handles.
  - The bound set (bin/node, every bundle file, the addon) is verified under held handles (no-follow, a regular
    file, owned by this user, not group- or world-writable, its size and sha256) after staging and before the
    activate, which is one atomic rename of the exact tree; the prior verified version stays until then.  A crash
    leaves the prior version; an unfinished staging tree is removed at the next start.  No downgrade, no reuse across
    versions, no package resolution.
  - At every launch the whole bound set is verified again the same way, before Node is started.
  - Linux with musl is refused in words, as is a platform the manifest doesn't carry.  Nothing falls back to another
    version, another engine or a Node found on PATH.
"""

import hashlib
import json
import lzma
import os
import platform as _platform
import re
import shutil
import stat
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

RUNTIME_ORIGIN = "https://sagebrush.space"
RUNTIME_PATH = "/runtime/"  # (the manifest: RUNTIME_ORIGIN + RUNTIME_PATH + "<version>/manifest.json"; files beside it)
# (the canonical manifest bytes' sha256 for each released version: written by the release step, never by hand)
MANIFEST_PINS = {}
PLATFORMS = ("linux-x64-gnu", "linux-arm64-gnu", "darwin-arm64", "darwin-x64")
LIMITS = {
    "manifestBytes": 1 * 1024 * 1024,
    "fileBytes": 512 * 1024 * 1024,   # (one file of the runtime: Node's archive is the largest, about 30 MB)
    "files": 4096,                    # (the bundle's files)
    "connectS": 15,
    "deadlineS": 600,                 # (one file's whole fetch)
    "redirects": 3,
}
_PATH = re.compile(r"[A-Za-z0-9._@+-]+(/[A-Za-z0-9._@+-]+)*\Z")
_SHA = re.compile(r"[0-9a-f]{64}\Z")
_VERSION = re.compile(r"(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\Z")


class RuntimeError_(Exception):
    """A runtime that can't be fetched, verified or used: the words to show."""


def refuse(msg):
    raise RuntimeError_(msg)


# ---- the platform

def this_platform(system=None, machine=None, libc=None):
    """This machine's platform key, or RuntimeError_ in words (musl, or one the runtime isn't built for)."""
    system = system or _platform.system()
    machine = (machine or _platform.machine()).lower()
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
    if system == "Linux":
        if libc is None:
            try:
                libc = "glibc" if os.confstr("CS_GNU_LIBC_VERSION") else "other"
            except (ValueError, OSError, AttributeError):
                libc = "other"
        if libc != "glibc":
            refuse("This machine's C library (musl, or not glibc) isn't supported yet for Sagebrush kernels here; "
                   "Native (Python) works without it.")
        key = "linux-%s-gnu" % arch if arch else None
    elif system == "Darwin":
        key = "darwin-%s" % arch if arch else None
    else:
        key = None
    if key not in PLATFORMS:
        refuse("Sagebrush kernels aren't built for this machine (%s %s) yet; Native (Python) works without them."
               % (system, machine))
    return key


# ---- the manifest

def strict_path(p):
    """A manifest path: strict relative (no leading /, no . or .., no empty part, no backslash), or refused."""
    if not isinstance(p, str) or not _PATH.match(p) or any(part in (".", "..") for part in p.split("/")):
        refuse("the runtime's manifest names a path that isn't allowed: %r" % (p,))
    return p


def _entry(e, what, mode=True):
    if not isinstance(e, dict):
        refuse("the runtime's manifest: %s is malformed" % what)
    keys = {"path", "size", "sha256"} | ({"mode"} if mode else set())
    extra = set(e) - keys - {"build", "napi", "version"}
    if extra or not keys <= set(e):
        refuse("the runtime's manifest: %s has the wrong fields" % what)
    strict_path(e["path"])
    if type(e["size"]) is not int or not 0 <= e["size"] <= LIMITS["fileBytes"] or not isinstance(e["sha256"], str) or not _SHA.match(e["sha256"]):
        refuse("the runtime's manifest: %s's size or sha256 is malformed" % what)
    if mode and (type(e["mode"]) is not int or e["mode"] not in (0o644, 0o755)):
        refuse("the runtime's manifest: %s's mode is malformed" % what)
    return e


def parse_manifest(raw, version, pins=None):
    """The manifest's bytes, checked against the pin for `version` (the wheel's), then parsed strictly."""
    pins = MANIFEST_PINS if pins is None else pins
    pin = pins.get(version)
    if pin is None:
        refuse("This sagebrush (%s) has no pinned runtime: Sagebrush kernels can't run here with it." % version)
    if len(raw) > LIMITS["manifestBytes"] or hashlib.sha256(raw).hexdigest() != pin:
        refuse("The runtime's manifest doesn't match this sagebrush's pin; nothing was installed.")
    try:
        m = json.loads(raw.decode("utf-8"), object_pairs_hook=_no_dupes)
    except (ValueError, UnicodeDecodeError):
        refuse("The runtime's manifest isn't valid JSON.")
    if not isinstance(m, dict) or m.get("version") != version or not _VERSION.match(version):
        refuse("The runtime's manifest isn't for this sagebrush (%s)." % version)
    b = m.get("bundle")
    if not isinstance(b, dict) or not isinstance(b.get("files"), list) or not isinstance(b.get("build"), str):
        refuse("the runtime's manifest: the bundle is malformed")
    if len(b["files"]) > LIMITS["files"]:
        refuse("the runtime's manifest: too many bundle files")
    seen = set()
    for f in b["files"]:
        _entry(f, "a bundle file")
        if f["path"] in seen:
            refuse("the runtime's manifest names %s twice" % f["path"])
        seen.add(f["path"])
    plats = m.get("platforms")
    if not isinstance(plats, dict) or set(plats) - set(PLATFORMS):
        refuse("the runtime's manifest: the platforms are malformed")
    for key, p in plats.items():
        n = p.get("node") if isinstance(p, dict) else None
        if not isinstance(n, dict) or not isinstance(n.get("version"), str):
            refuse("the runtime's manifest: %s's node is malformed" % key)
        _entry(n.get("archive"), "%s's node archive" % key, mode=False)
        _entry(n.get("bin"), "%s's node executable" % key)
        members = n.get("members")
        if not isinstance(members, list) or not members:
            refuse("the runtime's manifest: %s's node members are malformed" % key)
        mseen = set()
        for mem in members:
            if not isinstance(mem, dict) or set(mem) != {"name", "type"} or mem["type"] not in ("file", "dir"):
                refuse("the runtime's manifest: a node member is malformed")
            strict_path(mem["name"].rstrip("/"))
            if mem["name"] in mseen:
                refuse("the runtime's manifest names a node member twice")
            mseen.add(mem["name"])
        if not isinstance(n.get("extract"), list) or n["extract"] != [n["bin"]["path"]] or n["bin"]["path"] not in mseen:
            refuse("the runtime's manifest: only node's executable is extracted, and it must be a listed member")
        if "addon" in p:
            a = _entry(p["addon"], "%s's addon" % key)
            if not isinstance(a.get("build"), str) or type(a.get("napi")) is not int:
                refuse("the runtime's manifest: %s's addon is malformed" % key)
    return m


def _no_dupes(pairs):
    keys = [k for k, _ in pairs]
    if len(set(keys)) != len(keys):
        raise ValueError("a key twice")
    return dict(pairs)


# ---- fetching (only the compiled-in origin)

class _SameOrigin(urllib.request.HTTPRedirectHandler):
    max_redirections = LIMITS["redirects"]

    def __init__(self, origin):
        super().__init__()
        self.origin = origin

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl)[:2] != urllib.parse.urlsplit(self.origin)[:2]:
            raise urllib.error.HTTPError(newurl, code, "a redirect away from the runtime's origin", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def https_get(path, max_bytes, sink=None):
    """GET RUNTIME_ORIGIN + path, at most max_bytes (the body's bytes, or written to sink), by one deadline."""
    if not RUNTIME_ORIGIN.startswith("https://"):
        refuse("the runtime's origin isn't HTTPS")
    return _get(RUNTIME_ORIGIN, path, max_bytes, sink)


def _get(origin, path, max_bytes, sink=None):
    """https_get's work, for one origin (tests: a local one)."""
    url = origin + path
    opener = urllib.request.build_opener(_SameOrigin(origin))
    deadline = time.monotonic() + LIMITS["deadlineS"]
    try:
        with opener.open(urllib.request.Request(url, headers={"User-Agent": "sagebrush-remote"}), timeout=LIMITS["connectS"]) as r:
            n, chunks = 0, []
            while True:
                if time.monotonic() > deadline:
                    refuse("fetching the runtime took too long")
                chunk = r.read1(1 << 20)  # (what has arrived, so the deadline is checked as bytes trickle in)
                if not chunk:
                    break
                n += len(chunk)
                if n > max_bytes:
                    refuse("a runtime file is larger than the manifest says")
                if sink is not None:
                    sink(chunk)
                else:
                    chunks.append(chunk)
            return b"".join(chunks) if sink is None else n
    except (urllib.error.URLError, OSError) as e:
        refuse("can't fetch the runtime (%s)" % (getattr(e, "reason", None) or e))


# ---- the bound set, verified under held handles

def _open_dir(parent_fd, name):
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)


def _check_dir(fd, what, uid=None):
    """A held directory: ours, and not group- or world-writable (TESTS T1: every directory through activation and
    launch), or refused."""
    st = os.fstat(fd)
    if st.st_uid != (os.getuid() if uid is None else uid) or st.st_mode & 0o022:
        refuse("the runtime's folder %s isn't private to you (owner, or group- or world-writable)" % what)


def _walk_open(root_fd, rel, create=False, uid=None):
    """A held handle on rel's parent directory (no link anywhere on the way, each directory checked), and rel's last
    name."""
    parts = rel.split("/")
    fd = os.dup(root_fd)
    try:
        _check_dir(fd, "(its root)", uid)
        for i, part in enumerate(parts[:-1]):
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            nfd = _open_dir(fd, part)
            os.close(fd)
            fd = nfd
            _check_dir(fd, "/".join(parts[:i + 1]), uid)
        return fd, parts[-1]
    except BaseException:
        os.close(fd)
        raise


def _verify_member(root_fd, e, uid):
    """One bound member, under held handles: a regular file, not a link, ours, not group- or world-writable, with the
    manifest's mode, size and sha256; or refused."""
    dfd, name = _walk_open(root_fd, e["path"], uid=uid)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
    except OSError:
        os.close(dfd)
        refuse("the runtime's %s is missing or a link" % e["path"])
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != uid or st.st_mode & 0o022 or st.st_size != e["size"]:
            refuse("the runtime's %s isn't as installed (type, owner, mode or size)" % e["path"])
        if "mode" in e and stat.S_IMODE(st.st_mode) & 0o777 != e["mode"]:
            refuse("the runtime's %s has the wrong mode" % e["path"])
        h = hashlib.sha256()
        while True:
            b = os.read(fd, 1 << 20)
            if not b:
                break
            h.update(b)
        if h.hexdigest() != e["sha256"]:
            refuse("the runtime's %s doesn't match its manifest" % e["path"])
    finally:
        os.close(fd)
        os.close(dfd)


def bound_set(m, plat):
    """Every executable or loadable file a version runs: node's executable, the bundle's files, the addon."""
    p = m["platforms"][plat]
    out = [dict(p["node"]["bin"], path="node/" + p["node"]["bin"]["path"])]
    out += [dict(f, path="bundle/" + f["path"]) for f in m["bundle"]["files"]]
    if "addon" in p:
        out.append(dict(p["addon"], path="addon/" + p["addon"]["path"]))
    return out


def verify_tree(root_fd, m, plat, uid=None):
    uid = os.getuid() if uid is None else uid
    for e in bound_set(m, plat):
        _verify_member(root_fd, e, uid)


# ---- installing

def state_dir():
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "sagebrush", "remote", "runtime")


def _private_dir(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) & 0o077:
        refuse("the runtime's folder %s isn't private to you (owner and mode 0700 needed)" % path)
    return path


def _write_new(dfd, name, chunks_fn, mode):
    """An exclusive, no-follow create relative to the held directory, its bytes from chunks_fn(write), fsynced."""
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=dfd)
    try:
        chunks_fn(lambda b: os.write(fd, b))
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)


def _check_archive(archive_path, node):
    """Node's archive against its expected member list: every member listed (with its kind), none twice, no special
    files, links only within the tree; then bin/node's bytes, or refused."""
    expected = {m["name"].rstrip("/"): m["type"] for m in node["members"]}
    want = node["extract"][0]
    seen, data = set(), None
    try:
        with tarfile.open(archive_path, mode="r:*") as t:
            for ti in t:
                name = ti.name.rstrip("/")
                if name.startswith("/") or any(x in ("", ".", "..") for x in name.split("/")):
                    refuse("Node's archive has a path that leaves its folder: %r" % ti.name)
                if name in seen:
                    refuse("Node's archive names %s twice" % name)
                seen.add(name)
                kind = "dir" if ti.isdir() else "file" if ti.isreg() else None
                if kind is None:
                    refuse("Node's archive has a link or special file the manifest doesn't expect: %s" % name)
                if expected.get(name) != kind:
                    refuse("Node's archive has a member the manifest doesn't expect: %s" % name)
                if name == want:
                    f = t.extractfile(ti)
                    data = f.read(LIMITS["fileBytes"] + 1)
    except (tarfile.TarError, lzma.LZMAError, OSError, EOFError) as e:
        refuse("Node's archive can't be read (%s)" % e)
    if seen != set(expected):
        refuse("Node's archive doesn't have exactly the members the manifest lists")
    if data is None:
        refuse("Node's archive has no %s" % want)
    return data


def install(version, plat=None, get=None, root=None, pins=None, versions_seen=None):
    """Fetch, verify and activate `version`'s runtime for this platform: its folder, or RuntimeError_.  `get(path,
    max_bytes, sink=None)` fetches from the runtime's origin (https_get; tests: a double)."""
    get = get or https_get
    root = _private_dir(root or state_dir())
    plat = plat or this_platform()
    current = read_current(root)
    if current is not None and _vt(version) < _vt(current):
        refuse("This sagebrush (%s) is older than the runtime already installed (%s): no downgrade." % (version, current))
    cleanup_staging(root)
    raw = get("%s%s/manifest.json" % (RUNTIME_PATH, version), LIMITS["manifestBytes"])
    m = parse_manifest(raw, version, pins)
    if plat not in m["platforms"]:
        refuse("This sagebrush's runtime isn't built for this machine (%s)." % plat)
    p = m["platforms"][plat]
    final = os.path.join(root, "versions", version)
    if os.path.lexists(final):
        refuse("The runtime %s is already installed; reinstall by removing it first." % version)
    _private_dir(os.path.join(root, "versions"))
    stage = os.path.join(root, "staging-%s-%d" % (version, os.getpid()))
    os.mkdir(stage, 0o700)
    sfd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        # (Node: its archive into the staging folder, verified; only its executable written into the tree)
        arch = p["node"]["archive"]
        h = hashlib.sha256()

        def fetch_archive(w):
            get("%s%s/%s" % (RUNTIME_PATH, version, arch["path"]), arch["size"], sink=lambda b: (h.update(b), w(b)))
        _write_new(sfd, "node-archive", fetch_archive, 0o600)
        if h.hexdigest() != arch["sha256"] or os.stat("node-archive", dir_fd=sfd).st_size != arch["size"]:
            refuse("Node's archive doesn't match the manifest.")
        data = _check_archive(os.path.join(stage, "node-archive"), p["node"])
        os.unlink("node-archive", dir_fd=sfd)
        b = p["node"]["bin"]
        dfd, name = _walk_open(sfd, "node/" + b["path"], create=True)
        try:
            _write_new(dfd, name, lambda w: w(data), b["mode"])
        finally:
            os.close(dfd)
        # (the bundle's files, and the addon, each fetched into its own exclusive create)
        files = [("bundle/" + f["path"], f) for f in m["bundle"]["files"]]
        if "addon" in p:
            files.append(("addon/" + p["addon"]["path"], p["addon"]))
        for rel, f in files:
            # (where the release serves it: bundle/<path>, addon/<platform>/<path>)
            src = rel if not rel.startswith("addon/") else "addon/%s/%s" % (plat, f["path"])
            dfd, name = _walk_open(sfd, rel, create=True)
            try:
                _write_new(dfd, name, lambda w, f=f, src=src: get("%s%s/%s" % (RUNTIME_PATH, version, src), f["size"], sink=w), f["mode"])
            finally:
                os.close(dfd)
        _write_new(sfd, "manifest.json", lambda w: w(raw), 0o600)
        # (the whole bound set, under held handles, then the activate: one rename of this exact tree)
        verify_tree(sfd, m, plat)
        os.rename(stage, final)
        # (TESTS T3: the activated tree verified again, through its own handle, before "current" names it; anything
        # changed between the first verify and the rename takes the new version out, and the prior stays current)
        ffd = os.open(final, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            verify_tree(ffd, m, plat)
        except BaseException:
            shutil.rmtree(final, ignore_errors=True)
            raise
        finally:
            os.close(ffd)
        _write_current(root, version)
        return final
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    finally:
        os.close(sfd)


def cleanup_staging(root):
    """Unfinished staging trees (a crash, or a refusal that couldn't tidy up) removed; never a version's tree."""
    for n in os.listdir(root):
        if n.startswith("staging-"):
            shutil.rmtree(os.path.join(root, n), ignore_errors=True)


def _vt(v):
    return tuple(int(x) for x in v.split("."))


def read_current(root):
    try:
        with open(os.path.join(root, "current"), encoding="ascii") as f:
            v = f.read().strip()
    except OSError:
        return None
    return v if _VERSION.match(v) else None


def _write_current(root, version):
    tmp = os.path.join(root, "current.tmp")
    with open(tmp, "w", encoding="ascii") as f:
        f.write(version + "\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, os.path.join(root, "current"))


def launch_check(version, plat=None, root=None, pins=None):
    """Before every launch: the installed version's manifest against its pin, and its whole bound set verified under
    held handles.  The paths to run (node, the bundle's root, the addon or None), or RuntimeError_."""
    root = root or state_dir()
    plat = plat or this_platform()
    # (TESTS T2: only the current version runs; an older one kept on disk is never launched)
    current = read_current(root)
    if current != version:
        refuse("This sagebrush (%s) isn't the runtime installed as current (%s): no downgrade, and no other version."
               % (version, current or "none"))
    vdir = os.path.join(root, "versions", version)
    try:
        vfd = os.open(vdir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        refuse("This sagebrush's runtime (%s) isn't installed." % version)
    try:
        mfd = os.open("manifest.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=vfd)
        try:
            raw = os.read(mfd, LIMITS["manifestBytes"] + 1)
        finally:
            os.close(mfd)
        m = parse_manifest(raw, version, pins)
        if plat not in m["platforms"]:
            refuse("This sagebrush's runtime isn't built for this machine (%s)." % plat)
        verify_tree(vfd, m, plat)
        p = m["platforms"][plat]
        return {"node": os.path.join(vdir, "node", p["node"]["bin"]["path"]), "bundle": os.path.join(vdir, "bundle"),
                "addon": os.path.join(vdir, "addon", p["addon"]["path"]) if "addon" in p else None, "manifest": m}
    finally:
        os.close(vfd)
