# @sagebrush/scipy-io

`scipy.io`'s MATLAB files for Sagebrush: `loadmat`, `savemat` and `whosmat`
(and `MatReadError`), as SciPy's. `scipy` itself is in lib/
(lib/scipy/__init__.py), whose `scipy.io` is this package: a submodule
found by its full name in the build's registry (src/compile.ts), imported
on first use.
