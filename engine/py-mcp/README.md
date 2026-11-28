# sagebrush-mcp: computational mathematics for AI agents

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent a
real computer algebra system for research mathematics, with Sage syntax and
exact, verified results. It is
[Sagebrush](https://github.com/sagemathinc/sagebrush): Rust engines, MIT OR
Apache-2.0. You don't need Sage, PARI or FLINT, or a C compiler; the
wheels cover Linux, macOS and Windows.

```sh
pip install sagebrush-mcp        # or: uvx sagebrush-mcp@latest
```

**Claude Code:** `claude mcp add sagebrush -- sagebrush-mcp`

**Claude Desktop, Cursor and other clients:** in the MCP configuration,

```json
{ "mcpServers": { "sagebrush": { "command": "sagebrush-mcp" } } }
```

(`uvx sagebrush-mcp@latest` as the command works without installing anything first, and uv checks for a newer release each time it starts.)

## Tools

- `sage`: run Sage code in a persistent session. `2^10`, `1/3` exact,
  `R.<x> = QQ[]`, `K.<a> = NumberField(x^3 - 11)`, `[1..10]`; variables
  persist between calls. It returns the printed output and the last value,
  and plots come back as SVG.
- `python`: the same session, as plain Python.
- `factor`, `number_field`, `newforms`: shortcuts for common questions.
- `guide`: what is implemented. `search_docs`: search the Sage library's
  documentation. `reset`: clear the session.
- `run_status`, `run_result`, `run_cancel`, `run_list`, `run_keep`: runs
  that outlast a call.
- `workspace_connect`, then the `workspace_*`, `chat_*` and
  `latex_comments_*` tools: the person's Sagebrush workspace, its chat panel
  and comments on a `.tex`, through the page they pair.

What the session covers:
- **Integers:** factoring (ECM and the quadratic sieve), primality.
- **Polynomials:** factoring and roots over ZZ and QQ.
- **Number fields:** maximal orders, prime decomposition, class groups,
  units and regulators (assuming GRH, as Sage and PARI do).
- **Exact linear algebra over ZZ and QQ:** det, rref, inverse, charpoly,
  kernels, Hermite and Smith forms, LLL.
- **Modular forms:** modular symbols, newforms with LMFDB labels, Hecke
  operators.
- **Elliptic curves:** conductors, ranks, a_p.
- **Plots.**

The results agree with Sage. The test suite, run under CPython, compares
more than 4,000 lines of output with Sage itself.

A `sage` or `python` call waits up to `wait` seconds (60 by default). If
the computation hasn't ended by then, the call returns a ticket and the
computation keeps running: `run_result` waits for it, and `run_cancel`
interrupts it (the session keeps its variables). Only a `run_deadline` you
give, or a cancel, stops it. `timeout` is the old name of `wait`.

This package is a thin entry point: the server is `sagebrush.mcp_server` in
the [`sagebrush`](https://pypi.org/project/sagebrush/) package, so `pip
install sagebrush` also provides the `sagebrush-mcp` command.
