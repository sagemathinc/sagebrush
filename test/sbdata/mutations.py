# The replay layer's mutants (test/sbdata/mutants.json names their FAIL
# sets): each row (id, file, anchor, replacement) applied in order; every
# anchor must occur exactly once where it is applied.  Writes mutations.tsv
# (Python reprs, as the scipy.special controls):
#   python3 -I test/sbdata/mutations.py REPO OUT.tsv
import json
import os
import sys

repo, out = sys.argv[1:3]
SB = "lib/_sbdata.py"
RQ = "lib/urllib/request.py"
MOD = "src/runtime/modules.ts"
TEST = "test/sbdata.test.ts"
M = []


def mut(mid, f, a, b):
    M.append((mid, f, a, b))


mut("M-host-case", SB, '    h = h.lower()\n    if h.endswith("."):\n        h = h[:-1]\n    labels = h.split(".")', '    if h.endswith("."):\n        h = h[:-1]\n    labels = h.split(".")')
mut("M-trailing-dot", SB, '    h = h.lower()\n    if h.endswith("."):\n        h = h[:-1]\n    labels', '    h = h.lower()\n    labels')
mut("M-default-port", SB, '        if int(port) != {"http": 80, "https": 443}[scheme]:\n            host += ":" + str(int(port))', '        host += ":" + str(int(port))')
mut("M-unreserved-decode", SB, '            out.append(ch if ch in UNRESERVED else "%" + h.upper())', '            out.append("%" + h.upper())')
mut("M-malformed-pct", SB, '            if len(h) != 2 or h[0] not in HEX or h[1] not in HEX:\n                raise Refused("url")', '            if len(h) != 2 or h[0] not in HEX or h[1] not in HEX:\n                out.append(c)\n                i += 1\n                continue')
mut("M-dot-segments", SB, '    if any(seg in (".", "..") for seg in re.sub("%2[eE]", ".", p).split("/")):\n        raise Refused("url")\n', '')
mut("M-userinfo", SB, '    if "@" in auth:\n        raise Refused("url")\n    if auth.startswith("["):', '    auth = auth.rpartition("@")[2]\n    if auth.startswith("["):')
mut("M-empty-host-labels", SB, '    if not h or len(h) > 253 or not all(_LABEL.match(x) for x in labels):', '    if len(h) > 253 or not all(_LABEL.match(x) for x in labels if x):')
mut("M-ip-literal", SB, '    if last.isdigit() or (last.startswith("0x") and all(c in HEX for c in last[2:])):\n        raise Refused("url")\n', '')
mut("M-port-range", SB, '        if not port.isdigit() or not 1 <= int(port) <= 65535:', '        if not port.isdigit():')
mut("M-ascii-gate", SB, '    if not isinstance(url, str) or not _printable_ascii(url):\n        raise Refused("url")\n    m = re.match', '    if not isinstance(url, str):\n        raise Refused("url")\n    m = re.match')
mut("M-method", SB, '    if method not in ("GET", "HEAD"):\n        raise Refused("method")\n    return method', '    return method')
mut("M-scheme", SB, '    if scheme not in ("http", "https"):\n        raise Refused("url")\n', '')
mut("M-generic-json-parser", SB, '    return _Parser(text).document()', '    try:\n        return __import__("json").loads(text)\n    except ValueError:\n        raise Refused("not-json")')
mut("M-version-format", SB, '    if m["format"] != "sagebrush-data":\n        raise Refused("bad-value:format")\n    if not _int(m["version"]) or m["version"] != 1:\n        raise Refused("bad-value:version")\n', '')
mut("M-required-fields", SB, '    for f in REQUIRED:\n        if f not in e:\n            raise Refused("missing:" + f)\n', '')
mut("M-sha-format", SB, '    if not isinstance(e["sha256"], str) or not _SHA.match(e["sha256"]):\n        raise Refused("bad-value:sha256")\n', '')
mut("M-size-domain", SB, '    if not _int(e["size"]) or e["size"] < 0:\n        raise Refused("bad-value:size")\n', '')
mut("M-key-mismatch", SB, '    if k != key(e["method"], e["url"]):\n        raise Refused("key-mismatch")\n', '')
mut("M-cap-entries", SB, '    if len(entries) > ENTRIES_CAP:\n        raise Refused("cap:entries")\n', '')
mut("M-cap-url", SB, '    if len(u.encode("utf-8")) > URL_CAP:\n        raise Refused("cap:" + f)\n', '')
mut("M-cap-key-derived", SB, '    if len(k.encode("utf-8")) > len(e["method"]) + 1 + URL_CAP:\n        raise Refused("cap:key")\n', '')
mut("M-cap-metadata", SB, '    if len(v.encode("utf-8")) > META_CAP:\n        raise Refused("cap:" + f)\n', '')
mut("M-cap-folder", SB, '    if total > FOLDER_CAP:\n        raise Refused("cap:folder")\n', '')
mut("M-cap-entry-size", SB, '    if e["size"] > ENTRY_CAP:\n        raise Refused("cap:size")\n', '')
mut("M-cap-file-bytes", SB, '    raw = _fs.read_nofollow(snapdir + "/snapshot.json", FILE_CAP)', '    raw = _fs.read_nofollow(snapdir + "/snapshot.json", 10 ** 9)')
mut("M-encoding", SB, '    if raw[:3] == b"\\xef\\xbb\\xbf":\n        raise Refused("encoding")\n    try:\n        text = raw.decode("utf-8")\n    except UnicodeDecodeError:\n        raise Refused("encoding")', '    text = raw.decode("utf-8", "replace")')
mut("M-via-enum", SB, '    if e["via"] not in ("relay", "import", "converted"):\n        raise Refused("bad-value:via")\n', '')
mut("M-converted-from", SB, '    if e["via"] == "converted" and "converted_from" not in e:\n        raise Refused("missing:converted_from")\n', '')
mut("M-source-host", SB, '    if e["source"] != host_of(normalize_url(e["url"])):\n        raise Refused("bad-value:source")\n', '')
mut("M-manifest-fred", SB, '    if is_fred(u):\n        raise Refused("fred")\n', '')
mut("M-revision", SB, '    if not _int(m["revision"]) or not 1 <= m["revision"] <= 2 ** 53 - 1:\n        raise Refused("bad-value:revision")\n', '')
mut("M-manifest-credential", SB, '    if q and any(_cred(p.partition("=")[0]) for p in q.split("&")):\n        raise Refused("bad-value:" + f)\n', '')
mut("M-sha-recheck-skipped", SB, '    if hashlib.sha256(buf).hexdigest() != h:\n        raise Miss("invalid-blob", "the pinned bytes don\'t match their sha256")\n', '')
mut("M-length-check-off", SB, '    if len(buf) != e["size"]:\n        raise Miss("invalid-blob", "the pinned bytes have the wrong length")\n', '')
mut("M-reread-after-verify", SB, '        raise Miss("invalid-blob", "the snapshot changed while it was read")\n    return buf', '        raise Miss("invalid-blob", "the snapshot changed while it was read")\n    if _test_after_verify is not None:\n        _test_after_verify(path)\n    buf = _fs.read_nofollow(path, e["size"])\n    return buf')
mut("M-nofollow-dropped", MOD, 'fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK', 'fs.constants.O_RDONLY | fs.constants.O_NONBLOCK')
mut("M-component-symlink", SB, 'def _real_dir(p):\n    return _fs.lstat_kind(p)[0] == "dir"', 'def _real_dir(p):\n    return _fs.lstat_kind(p)[0] in ("dir", "link")')
mut("M-regular-file", MOD, '      if (!st.isFile()) return "not-regular";\n', '')
mut("M-nonblock-dropped", MOD, 'fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK', 'fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW')
mut("M-farthest-wins", SB, '    d = here\n    while True:\n        marker = d + "/.sagebrush-data"',
    '    levels = [here]\n    while levels[-1] != root:\n        levels.append(_parent(levels[-1]))\n    for d in reversed(levels):\n        marker = d + "/.sagebrush-data"')
mut("M-farthest-wins", SB, '        if d == root:\n            raise Miss("no-snapshot", "no snapshot in this folder")\n        d = _parent(d)\n',
    '    raise Miss("no-snapshot", "no snapshot in this folder")\n')
mut("M-walk-above-root", SB, '        if d == root:\n            raise Miss("no-snapshot", "no snapshot in this folder")', '        if d == "/":\n            raise Miss("no-snapshot", "no snapshot in this folder")')
mut("M-d6-fallback", SB, '            except Refused as e:\n                raise Miss("invalid-snapshot", "this folder\'s snapshot is invalid (%s)" % e.code)', '            except Refused as e:\n                pass')
mut("M-prefix-containment", SB, '    return root == "/" or path == root or path.startswith(root + "/")', '    return path.startswith(root)')
mut("M-no-realpath-cwd", SB, '    here = _fs.realpath(".")', '    here = __import__("os").getcwd()')
mut("M-fred-removed", RQ, '    if _sbdata.is_fred(u):\n        raise _error("fred", "FRED is fetched live with your own key (not available yet)")\n', '')
mut("M-fred-after-lookup", RQ, '    if _sbdata.is_fred(u):\n        raise _error("fred", "FRED is fetched live with your own key (not available yet)")\n', '')
mut("M-fred-after-lookup", RQ, '            raise _sbdata.Miss("not-pinned", "not in this folder\'s snapshot: %s" % shown)', '            if _sbdata.is_fred(u):\n                raise _error("fred", "FRED is fetched live with your own key (not available yet)")\n            raise _sbdata.Miss("not-pinned", "not in this folder\'s snapshot: %s" % shown)')
mut("M-fred-hosts-api-only", SB, 'FRED_HOSTS = frozenset(["api.stlouisfed.org", "fred.stlouisfed.org", "alfred.stlouisfed.org"])', 'FRED_HOSTS = frozenset(["api.stlouisfed.org"])')
mut("M-redact-raw-name", SB, '    return _unquote(name).lower()', '    return name.lower()')
mut("M-redact-case", SB, '    return _unquote(name).lower()', '    return _unquote(name)')
mut("M-redact-substring", SB, '    return n in CRED_NAMES', '    return any(c in n for c in CRED_NAMES)')
mut("M-redact-first-only", SB, '            parts.append(name + "=<redacted>" if _cred(name) else p)', '            parts.append(name + "=<redacted>" if _cred(name) and not any(x.endswith("=<redacted>") for x in parts) else p)')
mut("M-redact-blank", SB, '            parts.append(name + "=<redacted>" if _cred(name) else p)', '            parts.append(name + "=<redacted>" if _cred(name) and p.partition("=")[2] else p)')
mut("M-redact-userinfo", SB, '        auth = "<redacted>@" + auth.rpartition("@")[2]', '        auth = auth')
mut("M-redact-fragment", SB, '        s += "?" + "&".join(parts)\n    return s\n', '        s += "?" + "&".join(parts)\n    return s + url[len(url.partition("#")[0]):]\n')
mut("M-redact-unparseable", SB, '    if m is None or not re.match(r"[A-Za-z0-9.\\-:@%_~!$&\'()*+,;=]*\\Z", m.group(2)):\n        return "<unparseable URL>"', '    if m is None or not re.match(r"[A-Za-z0-9.\\-:@%_~!$&\'()*+,;=]*\\Z", m.group(2)):\n        return url')
mut("M-header-refusal", RQ, '        if cls is not None:\n            raise _error("header", "request header not supported by replay (%s): %s" % (cls, name))\n', '')
mut("M-head-from-get", RQ, '        e = entries.get(k)\n', '        e = entries.get(k) or entries.get(k.replace("HEAD ", "GET ", 1))\n')
mut("M-spy-not-in-worker", TEST, 'workerData: { sagebrushCli: { argv: ${JSON.stringify(argv)} } } });', 'execArgv: [], workerData: { sagebrushCli: { argv: ${JSON.stringify(argv)} } } });')
mut("M-forbidden-import", SB, '\nimport _fs\n', '\nimport _fs\ntry:\n    import socket\nexcept ImportError:\n    pass\n')

# (check: per id, apply its rows in order; each anchor exactly once there)
ids = []
for mid, *_ in M:
    if mid not in ids:
        ids.append(mid)
bad = []
for mid in ids:
    files = {}
    for m2, f, a, b in M:
        if m2 != mid:
            continue
        s = files.get(f) or open(os.path.join(repo, f)).read()
        n = s.count(a)
        if n != 1:
            bad.append("%s: %s anchor occurs %d times" % (mid, f, n))
            continue
        files[f] = s.replace(a, b)
expected = json.load(open(os.path.join(repo, "test/sbdata/mutants.json")))
names = {k for k in expected if not k.startswith("_")}
if set(ids) != names:
    bad.append("ids vs mutants.json: only here %s; only there %s" % (sorted(set(ids) - names), sorted(names - set(ids))))
if bad:
    print("\n".join(bad))
    sys.exit(1)
with open(out, "w") as o:
    o.write("id\tfile\tanchor (Python repr)\treplacement (Python repr)\n")
    for mid, f, a, b in M:
        o.write("%s\t%s\t%r\t%r\n" % (mid, f, a, b))
print(len(ids), "mutants,", len(M), "rows")
