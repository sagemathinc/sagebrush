#!/usr/bin/env node
// Turn on Node's compile cache (faster starts after the first), then run.
try {
  require("node:module").enableCompileCache?.();
} catch {}
require("../dist/sagebrush.cjs");
