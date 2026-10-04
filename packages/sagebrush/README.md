# sagebrush

Python 3.14 on a JavaScript runtime, aimed at research mathematics.

```
npx sagebrush                 # interactive prompt (tab completion, history)
npx sagebrush script.py       # run a program
npx sagebrush -c 'print(2**200)'
```

or `npm install -g sagebrush`, then `sagebrush`.

- The whole thing is one JavaScript file (about 2 MB) with its Python
  library embedded. It runs on Node 22+, Deno (`deno run -A`) and Bun, and
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
[Sagebrush](https://github.com/sagemathinc/sagebrush); the Rust/WebAssembly
mathematics engines (modular forms, elliptic curves, …) are published
separately as `sagebrush-web` and will be exposed here as Python modules.

See `NOTICE.md` for licensing.
