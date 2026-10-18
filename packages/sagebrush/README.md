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

- The whole thing is one JavaScript file, with its Python library, the
  notebook page and the WebAssembly engines embedded. It runs on Node 22+,
  Deno (`deno run -A`) and Bun.
- Measured for version 0.5.0 on Oct 18, 2026 (Node 26.12, an idle Linux VM
  with an AMD EPYC 7B13, the file cache warm):
  - the installed package is 25.7 MB, its script 25.5 MB;
  - `sagebrush -c 'print(1 + 1)'` takes 400 ms from start to exit (the
    median of 15 runs), with a peak resident memory of 166 MB; most of that
    time is V8 reading and compiling the script;
  - with `import numpy` it takes about 480 ms and 185 MB.
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
