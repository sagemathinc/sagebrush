"""The sagebrush command.

    sagebrush bench [...]     the benchmarks behind the performance claims
                              (sagebrush bench --help)

Sage files run with python -m sagebrush FILE.sage; the MCP server is
sagebrush-mcp."""

import sys


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == "bench":
        from .bench import main as bench

        return bench(argv[1:])
    print(__doc__.strip())
    return 0 if argv and argv[0] in ("-h", "--help") else 2


if __name__ == "__main__":
    sys.exit(main())
