<!-- description: How fast Sagebrush is, measured against other ways of running Python and mathematics in the browser: what each downloads, how fast it starts, how fast it runs, and what each does not claim. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from measurements of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
# Performance

These articles measure Sagebrush against other systems that do the same job
in the browser. Each one uses a script in the repository that anyone can run,
and says how the measurement was taken. Each one also says what Sagebrush does
not claim: a faster number does not matter if the answer is wrong.

1. [Sagebrush and Pyodide, measured](01-sagebrush-and-pyodide.md): download
   size, start-up, `import numpy` and a few workloads, against Pyodide
   (CPython compiled to WebAssembly), and the limits of Sagebrush's Python.
