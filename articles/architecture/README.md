<!-- description: A map of how Sagebrush is built: the Rust engine, pyjs (Python compiled to JavaScript), the browser app, the command line, sync, sharing, the servers and the checks, each with a link to the code that shows it best. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code and design notes of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
<!-- (written from architecture.board.json by scripts/architecture-article.mjs: edit the board, then run it with --write) -->
# The architecture

How Sagebrush is built, as one map: the Rust engine, pyjs (Python 3.14 compiled to JavaScript), the browser app, the command line, sync, sharing, the servers, and the checks every change passes. Each part has a few short notes, and each note links to the one file that best shows its idea, pinned to a commit.

**[Open the map as an interactive board](/board/?doc=/articles/architecture/architecture.board.json)**: pan, zoom in for details, and press Play for a guided tour. It works on a phone too.

1. [The map](01-the-map.md): the board's text, region by region, for reading without the board.

Last updated 2026-10-25, at sagebrush [`cfa609d4`](https://github.com/sagemathinc/sagebrush/tree/cfa609d474f72401fa7e8792a5c2291a7d22b5c5).
The map is refreshed when the architecture changes, and every link in it is checked against the repository at that commit.
