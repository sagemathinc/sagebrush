"""The sagebrush command.

    sagebrush bench [...]     the benchmarks behind the performance claims
                              (sagebrush bench --help)
    sagebrush remote --loopback [--port N]
                              this computer as a sagebrush.space page's
                              "Your computer (paired)" runner, in this Python
    sagebrush remote login [--origin URL] [--name NAME] [--force]
                              enroll this computer with your account
                              (for the cloud relay)

Sage files run with python -m sagebrush FILE.sage; the MCP server is
sagebrush-mcp."""

import sys


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == "bench":
        from .bench import main as bench

        return bench(argv[1:])
    if argv and argv[0] == "remote":
        from .remote.pair import main as remote

        return remote(argv[1:])
    print(__doc__.strip())
    return 0 if argv and argv[0] in ("-h", "--help") else 2


if __name__ == "__main__":
    sys.exit(main())
