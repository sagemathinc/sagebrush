# sagebrush-mcp: computational mathematics for AI agents

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent a
real computer algebra system for research mathematics, with Sage syntax and
exact, verified results. It is
[Sagebrush](https://github.com/sagemathinc/sagebrush): Rust engines, MIT OR
Apache-2.0. You don't need Sage, PARI or FLINT, or a C compiler; the
wheels cover Linux, macOS and Windows.

```sh
pip install sagebrush-mcp        # or: uvx sagebrush-mcp
```

**Claude Code:** `claude mcp add sagebrush -- sagebrush-mcp`

**Claude Desktop, Cursor and other clients:** in the MCP configuration,

```json
{ "mcpServers": { "sagebrush": { "command": "sagebrush-mcp" } } }
```

(`uvx sagebrush-mcp` as the command works without installing anything first.)

## Tools

- `sage`: run Sage code in a persistent session. `2^10`, `1/3` exact,
  `R.<x> = QQ[]`, `K.<a> = NumberField(x^3 - 11)`, `[1..10]`; variables
  persist between calls. It returns the printed output and the last value,
  and plots come back as SVG.
- `python`: the same session, as plain Python.
- `factor`, `number_field`, `newforms`: shortcuts for common questions.
- `guide`: what is implemented. `reset`: clear the session.

What the session covers:
- **Integers:** factoring (ECM), primality.
- **Polynomials:** factoring and roots over ZZ and QQ.
- **Number fields:** maximal orders, prime decomposition, class groups,
  units and regulators (assuming GRH, as Sage and PARI do).
- **Exact linear algebra over ZZ and QQ:** det, rref, inverse, charpoly,
  kernels, Hermite and Smith forms, LLL.
- **Modular forms:** modular symbols, newforms with LMFDB labels, Hecke
  operators.
- **Elliptic curves:** conductors, ranks, a_p.
- **Plots.**

The results agree with Sage. The test suite compares 3,500 lines of
output with Sage itself.

Each computation has a time limit (`timeout`, default 60 s). When it
expires, the computation is interrupted and the session keeps its
variables.

This package is a thin entry point: the server is `sagebrush.mcp_server` in
the [`sagebrush`](https://pypi.org/project/sagebrush/) package, so `pip
install sagebrush` also provides the `sagebrush-mcp` command.
