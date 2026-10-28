"""No cleanup on the PNG Stop path is left to a `finally`, an `except` or a
`with` (#157's binding gate from its findings: under a KeyboardInterrupt,
CPython 3.9 and 3.14 can leave `with lock:` holding the lock, and 3.13 and
3.14 can skip a try around a loop, python/cpython#130279).  Cleanup lives
in native frames (guard.rs settled_call / locked_call, child.rs).

Fail-closed: every try and with statement in _sbraster, _raster_child and
_memledger must be one of the reviewed nodes below, each pinned by its
source's digest, so that any new or changed one fails until reviewed.

    python engine/py/test_stop_path_ast.py
"""
import ast
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "python", "sagebrush", "_sagelib")
FILES = ("_sbraster.py", "_raster_child.py", "_memledger.py")

# (file, function, what) -> (the node's source digest, why it is not cleanup)
ALLOWED = {
    ("_sbraster.py", "_handshake", "except (rc._Exited, rc.ProtocolError)"):
        ("e61cb8d79038", "classification: the startup's outcome raised as its error (the reap is for the status; settle reaps anyway)"),
    ("_sbraster.py", "_start", "except rc.FootprintRefused"):
        ("014a3fdee617", "control flow: the contained replacement, or the enforced refusal"),
    ("_sbraster.py", "_admit", "except _memledger.NeedReap"):
        ("32f939b2b1e4", "control flow: the warm engine ended and the memory observed again"),
    ("_sbraster.py", "_exchange", "except rc.ProtocolError | except rc._Exited"):
        ("b2268834ec31", "classification: the reply's failure raised as its error (settle ends the child)"),
    ("_raster_child.py", "_launcher", "except OSError"):
        ("873c7390467b", "a failed read is a launcher that isn't used"),
    ("_raster_child.py", "_launcher", "with open(p, 'rb')"):
        ("bd67c1acc518", "a read-only file, closed by its refcount on any exit: no obligation"),
    ("_raster_child.py", "_segments", "with open(path, 'rb')"):
        ("583e190b21db", "a read-only file, closed by its refcount on any exit: no obligation"),
    ("_raster_child.py", "_special_mappings", "except OSError"):
        ("157b6b4a4295", "a failed read counts nothing"),
    ("_raster_child.py", "_special_mappings", "with open('/proc/self/maps')"):
        ("4101f2877e76", "a read-only file, closed by its refcount on any exit: no obligation"),
    ("_raster_child.py", "_statm", "except (OSError, ValueError, IndexError)"):
        ("63e623bfe5a8", "a failed read is no figure"),
    ("_raster_child.py", "Child.stderr_tail", "except (OSError, ValueError)"):
        ("1ad3043a0722", "a failed read is an empty tail"),
    ("_raster_child.py", "spawn_into", "except OSError"):
        ("b49e6720f8b4", "the creation's error kept as text (nothing of it left: child.rs); raised, or replaced by the contained mode, after the handler"),
    ("_raster_child.py", "_blocking.run", "except BaseException"):
        ("610e8196e790", "the helper thread's outcome handed to the caller (a helper thread gets no KeyboardInterrupt)"),
    ("_raster_child.py", "_write_blocking", "except (BrokenPipeError, OSError)"):
        ("9f932a32fb30", "classification: a closed pipe is the child's exit"),
    ("_raster_child.py", "_read_blocking", "except OSError"):
        ("ed19ba02a4f3", "classification: a failed read is the child's exit"),
    ("_raster_child.py", "write_all", "except BlockingIOError | except BrokenPipeError"):
        ("9356fab872d7", "control flow: try again; a closed pipe is the child's exit"),
    ("_raster_child.py", "read_into", "except BlockingIOError"):
        ("6c53cc8e01b4", "control flow: try again"),
    ("_raster_child.py", "_oom_kills", "except (OSError, ValueError, IndexError)"):
        ("ebecfe78f442", "a failed read is no count"),
    ("_raster_child.py", "_oom_kills", "with open('/proc/self/cgroup')"):
        ("eadd9849d787", "a read-only file, closed by its refcount on any exit: no obligation"),
    ("_memledger.py", "<module>", "except ImportError"):
        ("10cb956637fc 2b43009a978e", "an optional import (twice)"),
    ("_memledger.py", "_release_log", "except (ImportError, AttributeError)"):
        ("edcd2d1fcd18", "the native log, else the Python one (pyjs)"),
    ("_memledger.py", "_python_locked_call", "with lock"):
        ("bb0d8db3ac40", "pyjs only, where a KeyboardInterrupt is raised only at loop polls; under CPython the native frame is used (checked below)"),
    ("_memledger.py", "_native_locked_call", "except (ImportError, AttributeError)"):
        ("0b480c0cf1c3", "the native frame, else None (pyjs)"),
    ("_memledger.py", "Ledger._figure", "except ImportError"):
        ("1983b891a40b", "no os module (pyjs): no environment"),
    ("_memledger.py", "Ledger._figure", "except ValueError"):
        ("927821474d9d", "a malformed SAGEBRUSH_MEMORY_BYTES is no figure"),
}


def digest(src, node):
    # (of the node's own source text: the same on every Python version)
    return hashlib.sha256(ast.get_source_segment(src, node).encode()).hexdigest()[:12]


def nodes():
    """(file, function, what, digest) for every try and with statement."""
    out = []
    for f in FILES:
        src = open(os.path.join(LIB, f)).read()
        tree = ast.parse(src)

        def walk(node, fn):
            for ch in ast.iter_child_nodes(node):
                if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    walk(ch, fn + "." + ch.name if fn else ch.name)
                    continue
                if isinstance(ch, ast.Try) or (sys.version_info >= (3, 11) and isinstance(ch, ast.TryStar)):
                    what = " | ".join("except " + (ast.unparse(h.type) if h.type else "") for h in ch.handlers)
                    if ch.finalbody:
                        what += (" | " if what else "") + "finally"
                    out.append((f, fn or "<module>", what, digest(src, ch)))
                elif isinstance(ch, (ast.With, ast.AsyncWith)):
                    what = "with " + ", ".join(ast.unparse(i.context_expr) for i in ch.items)
                    out.append((f, fn or "<module>", what, digest(src, ch)))
                walk(ch, fn)
        walk(tree, "")
    return out


def test_every_try_and_with_is_a_reviewed_non_cleanup_node():
    bad = []
    for f, fn, what, digest in nodes():
        entry = ALLOWED.get((f, fn, what))
        if entry is None:
            bad.append("NOT REVIEWED: %s %s: %s (digest %s)" % (f, fn, what, digest))
        elif digest not in entry[0].split():
            bad.append("CHANGED SINCE REVIEW: %s %s: %s (digest %s, reviewed %s)" % (f, fn, what, digest, entry[0]))
    assert not bad, "\n".join(bad)


def test_no_finally_anywhere():
    fin = [n for n in nodes() if "finally" in n[2]]
    assert not fin, fin


def test_the_ledger_uses_the_native_frame_under_cpython():
    sys.path.insert(0, LIB)
    import sagebrush  # noqa: F401
    import _memledger
    assert _memledger.Ledger()._locked_call is not _memledger._python_locked_call


if __name__ == "__main__":
    if "--digests" in sys.argv:
        for n in nodes():
            print(n)
        sys.exit(0)
    for n in [k for k in list(globals()) if k.startswith("test_")]:
        globals()[n]()
        print("ok", n, flush=True)
