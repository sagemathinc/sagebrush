"""`sagebrush remote login`: enroll this computer as a runner (design remote-v1 §3, the device flow, RFC 8628's shape).

The runner makes its key, sends the public half with a name, shows the user code and the page to approve it on, and
polls until the account approves, denies or the code expires.  Only then is the key file written, with the remote id
the account gave it.  Nothing secret is sent: the server sees the public key only."""

import json
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from sagebrush.remote import keys

DEFAULT_ORIGIN = "https://sagebrush.space"
_RESPONSE_BYTES = 8192
# (every request the runner makes names itself, its HTTP POSTs as its relay upgrade does: sagebrush.space's edge refuses
# urllib's default "Python-urllib/3.x" (Cloudflare error 1010, a 403 with no JSON), so without it the device flow and
# every connection's challenge failed there)
USER_AGENT = "sagebrush-remote/1"


class EnrollError(Exception):
    pass


def check_origin(origin):
    """An https origin, or http on loopback (development).  Returns it without a trailing slash."""
    if not isinstance(origin, str):
        raise EnrollError("the origin isn't a URL")
    u = urllib.parse.urlsplit(origin)
    host = u.hostname or ""
    if u.scheme == "https" and host:
        pass
    elif u.scheme == "http" and host in ("127.0.0.1", "localhost", "::1"):
        pass
    else:
        raise EnrollError("the origin must be https:// (or http:// on this computer, for development): %s" % origin)
    if u.path not in ("", "/") or u.query or u.fragment or u.username or u.password:
        raise EnrollError("the origin is a scheme and host only: %s" % origin)
    return "%s://%s" % (u.scheme, u.netloc)


def _post(origin, path, body, timeout=30.0):
    """(status, object) for a JSON POST; a non-JSON or oversized answer is an EnrollError."""
    req = urllib.request.Request(origin + path, data=json.dumps(body).encode("utf-8"), method="POST",
                                 headers={"content-type": "application/json", "accept": "application/json",
                                          "user-agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status, raw = r.status, r.read(_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read(_RESPONSE_BYTES + 1)
    except (urllib.error.URLError, socket.timeout, OSError) as e:
        raise EnrollError("can't reach %s (%s)" % (origin, getattr(e, "reason", e)))
    if len(raw) > _RESPONSE_BYTES:
        raise EnrollError("%s answered too much" % origin)
    try:
        v = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        v = None
    if not isinstance(v, dict):
        raise EnrollError("%s answered %d without JSON (is remote compute enabled there?)" % (origin, status))
    return status, v


def login(origin, name, kind="runner", out=None, sleep=time.sleep, clock=time.monotonic, post=_post):
    """The device flow; returns the enrolled RunnerKey (not yet saved)."""
    out = out or (lambda s: (sys.stderr.write(s), sys.stderr.flush()))
    origin = check_origin(origin)
    key = keys.RunnerKey.generate()
    status, d = post(origin, "/api/remote/v1/device", {"kind": kind, "name": name, "pub": key.jwk()})
    if status != 200:
        raise EnrollError("%s refused the enrollment: %s" % (origin, d.get("error", status)))
    code, uri = d.get("device_code"), d.get("verification_uri_complete") or d.get("verification_uri")
    user_code, interval, life = d.get("user_code"), d.get("interval", 5), d.get("expires_in", 600)
    if not (isinstance(code, str) and isinstance(user_code, str) and isinstance(uri, str)
            and type(interval) is int and type(life) is int and 1 <= interval <= 60 and 1 <= life <= 86400):
        raise EnrollError("%s answered the enrollment unexpectedly" % origin)
    u = urllib.parse.urlsplit(uri)
    if "%s://%s" % (u.scheme, u.netloc) != origin or any(ord(c) < 0x21 or ord(c) > 0x7e for c in uri + user_code):
        raise EnrollError("%s sent an unexpected approval page (another site?)" % origin)
    wait = "%d hours" % (life // 3600) if life >= 7200 else "%d minutes" % (life // 60)
    out("To let this computer run code for your sagebrush account, open\n  %s\nsigned in, and check that it shows "
        "the code %s.  (Waiting %s.)\n" % (uri, user_code, wait))
    end = clock() + life
    while True:
        sleep(interval)
        if clock() > end:
            raise EnrollError("the code expired; run sagebrush remote login again")
        status, r = post(origin, "/api/remote/v1/device/poll", {"device_code": code})
        if status == 200:
            rid = r.get("remote_id")
            if not isinstance(rid, str) or r.get("kind") != kind:
                raise EnrollError("%s answered the approval unexpectedly" % origin)
            key.remote_id, key.origin, key.name = rid, origin, r.get("name") if isinstance(r.get("name"), str) else name
            return key
        e = r.get("error")
        if e == "authorization_pending":
            continue
        if e == "slow_down":
            interval = min(interval + 5, 60)
            continue
        if e == "access_denied":
            raise EnrollError("the enrollment was denied")
        if e == "expired_token":
            raise EnrollError("the code expired; run sagebrush remote login again")
        raise EnrollError("%s refused: %s" % (origin, e or status))


def main(argv):
    """`sagebrush remote login [--origin URL] [--name NAME] [--force]`."""
    import os
    import platform
    origin = os.environ.get("SAGEBRUSH_REMOTE_ORIGIN") or DEFAULT_ORIGIN
    name, force = platform.node() or "my computer", False
    if argv[:1] in (["-h"], ["--help"]):
        # (the usage, on stdout; nothing enrolled, nothing sent)
        sys.stdout.write("usage: sagebrush remote login [--origin URL] [--name NAME] [--force]\n"
                         "  (enroll this computer with your account at https://sagebrush.space, or at --origin URL;\n"
                         "   --force: enroll it again, replacing this computer's key)\n")
        return 0
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--origin", "--name") and i + 1 < len(argv):
            i += 1
            if a == "--origin":
                origin = argv[i]
            else:
                name = argv[i]
        elif a == "--force":
            force = True
        else:
            sys.stderr.write("sagebrush remote login: unknown argument %s\n" % a)
            return 2
        i += 1
    try:
        old = keys.load()
    except keys.KeyFileError as e:
        old = None
        if not force:
            sys.stderr.write("sagebrush remote login: %s (or --force to enroll anew)\n" % e)
            return 1
    if old is not None and not force:
        sys.stderr.write("This computer is already enrolled as %s at %s (%s).  To enroll it again: --force (and revoke "
                         "the old one in your account's settings).\n" % (old.name, old.origin, old.remote_id))
        return 1
    try:
        key = login(origin, name[:64])
        path = keys.save(key)
    except (EnrollError, keys.KeyFileError) as e:
        sys.stderr.write("sagebrush remote login: %s\n" % e)
        return 1
    except KeyboardInterrupt:
        sys.stderr.write("\nNot enrolled.\n")
        return 130
    sys.stderr.write("Enrolled as %s (%s); the key is in %s.\n" % (key.name, key.remote_id, path))
    return 0
