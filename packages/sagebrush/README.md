# sagebrush

Python 3.14 on a JavaScript runtime, aimed at research mathematics.

```
npx sagebrush                 # interactive prompt (tab completion, history)
npx sagebrush script.py       # run a program
npx sagebrush -c 'print(2**200)'
npx sagebrush --sage          # Sage syntax: 2^3 == 8, 2/3 is exact, factor(), ...
```

or `npm install -g sagebrush`, then `sagebrush`.

## A Jupyter kernel

```
npx sagebrush --install-jupyter-kernel                 # "Sagebrush (Sage)"
npx sagebrush --install-jupyter-kernel --mode all      # + "Sagebrush (Python)", "Sagebrush (Magma)"
```

It works in JupyterLab, Notebook, VS Code and any other Jupyter client, and
installing it needs neither Python nor ZeroMQ: the kernel speaks the Jupyter
protocol over its own JavaScript ZeroMQ transport. In the notebook you get:
- Sage syntax with Sagebrush's engines: number fields and class groups,
  modular forms, elliptic curves, exact linear algebra;
- plots as SVG;
- streamed output, tab completion, and multi-line input checks;
- Stop (interrupt), which also stops the Rust engines.

`--user` (the default), `--sys-prefix` or `--prefix DIR` choose where the
kernelspec goes, and `--uninstall-jupyter-kernel` removes it. The
self-contained `sagebrush` executable
(`curl -fsSL https://get.sagebrush.space/install.sh | sh`) installs the same
kernel.

- The whole thing is one JavaScript file (about 5 MB) with its Python
  library and the WebAssembly engines embedded. It runs on Node 22+, Deno (`deno run -A`) and Bun, and
  starts in roughly 80 ms.
- The language is CPython 3.14's own grammar (the parser is generated from
  `Grammar/python.gram`); syntax errors match CPython's.
- Big integers, `fractions`, `complex`/`cmath`, `re`, `json`, `struct`,
  `collections`, `functools`, `pickle`, … are included. Pure-Python
  packages work too: mpmath 1.3 passes its entire test suite.
- Sandboxing comes for free from the runtime:
  `deno run --allow-read $(which sagebrush)` can read but never write, and
  denied operations raise `PermissionError`.

This is an early release of the Python front end of
[Sagebrush](https://github.com/sagemathinc/sagebrush), with its
Rust/WebAssembly mathematics engines built in.

See `NOTICE.md` for licensing.
