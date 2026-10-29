# Browser runner information

Add `?runner-info=1` to a notebook or board URL to enable the small runner
information UI. The flag changes presentation only; it never selects or disables
a sandbox. It is off by default while the UI is being tried.

When a ready browser interpreter is a plain worker, a **No sandbox** button
appears. This includes Safari/Firefox and Chromium after its runner has fallen
back. Clicking it opens a native dialog explaining the missing defense-in-depth
layer, that running your own code is fine, that Chrome supports the sandbox, and
that a separate-domain sandbox for all browsers is coming. A ready sandboxed
interpreter keeps the button hidden. Desktop/native execution is excluded.

Notebook interpreters and the console share one indicator; boards share one
across their language interpreters. Restart and board interpreter cleanup update
the indicator. An idle retained interpreter still contributes its current status.
Exported files and embedded board frames do not enable this UI.

Local validation after `bun web/build.ts`:

```sh
/home/user/sagebrush-coord/bin/ptest -m 4 -- node web/test-runner-pill.mjs
```

The browser test checks the default-off flag, the real notebook sandbox, plain
notebook execution, modal opening/dismissal, restart, an actual unavailable-runner
fallback in Chromium, and both plain and sandboxed board interpreters. It only
uses localhost, with the fallback caused by its test HTTP server. The runner CI
job also runs it after building the normal web application.
