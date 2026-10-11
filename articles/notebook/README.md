<!-- description: How Sagebrush's notebook runs your cells: a reactive notebook, like marimo's, in which what you see is what the cells compute, with page-order scoping for redefinitions and a time budget for automatic reruns. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code and design notes of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
# The notebook

The notebook on [sagebrush.space](https://sagebrush.space) is **reactive**.
Each cell's output is either what the cells compute as they are now, or it
is visibly marked stale. When you run a cell, the cells that depend on it
run again, in an order the notebook works out from the code.

This series describes exactly how that works, so that people and AI agents
can predict what the notebook will do.

1. [How cells run](01-how-cells-run.md): what a cell defines and reads, the
   dependency graph, page-order scoping for names defined in several cells,
   what runs and when (the time budget, stale cells), what the interpreter
   keeps, errors, outputs from elsewhere, notes for AI agents, limits, and
   the differences from marimo.
