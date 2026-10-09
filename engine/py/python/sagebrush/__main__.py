"""Run Sage code natively: the Rust engines compiled for this machine (all
cores where they use threads), Sage syntax through the preparser.

    python -m sagebrush FILE.sage [ARGS...]   # a Sage file (sys.argv = [FILE, ARGS...])
    python -m sagebrush -c "CODE"             # Sage code from the command line
    python -m sagebrush FILE.py               # plain Python with sagebrush.sage's names

Module paths of code written for Sage resolve to Sagebrush's names
(sage.rings.ideal.Katsura, from sage.all import *, ...), so a real Sage
installed in the same Python is not used by this command.
"""

import sys
import types


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    from sagebrush import sage as S  # sets up the library's import paths
    from sagebrush.preparse import preparse
    import _sage_shim

    _sage_shim.install()
    import sage as _sage_pkg

    if argv[0] == "-c":
        name, src, sage_syntax = "<string>", argv[1], True
        sys.argv = ["-c"] + argv[2:]
    else:
        name = argv[0]
        with open(name) as f:
            src = f.read()
        sage_syntax = not name.endswith(".py")
        sys.argv = argv
    main_mod = types.ModuleType("__main__")
    sys.modules["__main__"] = main_mod
    ns = main_mod.__dict__
    ns.update({k: getattr(S, k) for k in S.__all__})
    ns["sage"] = _sage_pkg
    ns["preparse"] = preparse
    code = preparse(src) if sage_syntax else src
    exec(compile(code, name, "exec"), ns)
    return 0


if __name__ == "__main__":
    sys.exit(main())
