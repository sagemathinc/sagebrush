# @sagebrush/bash

The bash shell's module (plan-bash-shell r3): just-bash 3.6.0 (Apache-2.0)
and the packages it bundles (THIRD-PARTY-NOTICES.txt), built into one ES
module by `scripts/optional-packages.mjs`. It runs only in the shell's own
worker (`web/shell/worker-boot.js`), which can't reach the network or eval.

## What a script can run

**Commands** (§8). These are the only ones registered:

- files: `ls cat head tail wc mkdir mv cp rm touch stat tree find`
- text: `grep sort uniq cut tr sed awk diff jq`
- shell: `echo printf pwd basename dirname env true false seq`

Every other command answers 127, "command not found". That includes network
commands (`curl`, `wget`), runtimes (`python3`, `node`, `js-exec`,
`sqlite3`), and whatever §8 defers (`tee`, `xargs`, `tar`, `gzip`, `ln`,
`split`, `rg`, `yq`, ...).

**The interpreter's builtins.** These are part of the shell itself, so they
run whatever is registered. There are 38 in just-bash 3.6.0:

```
. : [ break builtin cd command compgen complete compopt continue declare dirs
eval exec exit export getopts hash help let local mapfile popd pushd read
readarray readonly return set shift shopt source test type typeset unset wait
```

They work on the shell's own state: variables, functions, the directory
stack, and the script's control flow. None of them reaches the network or
another process. `eval` is the shell's eval, not JavaScript's. `source` and
`.` read the shell's files: the in-memory files here, and the workspace's
through the page's mediator from step 2.

`web/test-shell.mjs` takes a census in the shipped module. If a later
just-bash adds a builtin under any bash builtin name, or under one of its
command names, the census fails CI.

## What an invocation returns

`web/shell/loader.ts`'s `exec()` resolves with exactly one of two outcomes:

- `{exit: {code, stdout, stderr}}`: the shell exited, with `code` in 0..255;
- `{rejected: {message, refusal}}`: just-bash's `exec()` rejected. This is
  never folded into an exit status. `refusal` is the id of the page's refusal
  the module threw, if the rejected value is that very object, else null.

If the shell is gone (terminated, its worker failed, or its protocol broke),
`exec()` rejects with `ShellUnavailableError`: every pending call, and every
later one at once.

## Files: the workspace's, through the page

From 0.2.0 the shell's files are the workspace's. Each file call goes to the
page's mediator (`web/shell/host.ts`, ShellHost), which checks it against
the run's grant at use and answers with workspace verbs. The module keeps
nothing of the workspace. A page refuses an older shell (host level 1, step
1's in-memory files) for the workspace: "this document's package set has an
older shell; update the set".

What differs from bash, besides just-bash's own differences (D1–D8,
`test/bash-known.json`), is frozen in `test/bash-step2-known.json`:

- **A redirection is committed when the invocation ends.** An open with `>`
  of an existing file, or of a new path (and `touch` of a new file, which is
  the same call), is pending until the invocation ends, then committed.
  Later commands in the same invocation see it as an empty file. A commit
  refused at the end (a full folder, a change made elsewhere) is printed on
  stderr and makes a final status of 0 into 1, though an `echo $?` just after
  the command printed 0: `touch full/x && echo ok` prints `ok` here, then
  fails.
- **Each invocation ends clean.** What it left pending is committed or
  retired, and nothing it opened carries into the next invocation, as a
  finished `bash -c` keeps nothing open.
- **`mv` and `cp` onto an existing file are refused** ("File exists"):
  `mv -f` and copying over a file are deferred.
- **`cp -r` of a folder that holds a notebook or board copies nothing.**
  The shell changes data files and folders only; a document is copied in
  the file browser.
- **A path outside the grant looks missing.** Every command but `rm` says
  "No such file or directory" for it, since asking whether it exists tells
  nothing. `rm` says the host's refusal.
- **`rm` is silent**, as GNU rm is, though what it removes goes to Trash.

## Limits (0.3.0, host level 3)

From 0.3.0 the page fixes the shell's limits once, in the worker's init,
before any script runs, and refuses a second init. The page validates its
`bash` config against `BASH_RANGES` (`web/shell/limits.ts`) first, and refuses
an older shell on the workspace, since it would run with just-bash's own
defaults.

- **Own computation** (`script_ms`, `commands`, `loop_iterations`,
  `work_units`, `invocations`) is off by default. Off is exactly `+Infinity`
  in just-bash, so its own defaults (1 hour, 100,000 commands, 100,000 loop
  iterations, 100,000,000 work units) never apply.
- **A typed limit** ends the run with exit 125 and
  `bash: bash.<key> exceeded (<value>)`. This holds for the 12 keys the page
  or this module enforces: `script_ms`, `invocations`, `output_bytes`,
  `source_bytes`, `pipeline_width`, `list_entries`, `read_bytes`,
  `write_bytes`, `ops`, `cp_entries`, `cp_bytes` and `written_bytes`.
- **The 6 keys just-bash enforces itself** are `commands`, `loop_iterations`,
  `work_units`, `memory_bytes`, `call_depth` and `glob_paths`. They keep
  just-bash's own scope and command behaviour, and are ordinary outcomes:
  - they are not promised to stop the whole invocation (sed and awk turn the
    error into their own; the script can go on, even to exit 0);
  - no limit key is ever inferred from their words;
  - `glob_paths` sets both just-bash's glob operations and its brace
    expansion results. Only the brace side has a measured boundary in the
    tests; the glob side (`maxGlobOperations`) is still unmeasured.
- **Output:** `output_bytes` (default 64 MiB) is cumulative across a run's
  invocations, and each invocation delivers at most 32 MiB:
  - this module counts each result in UTF-8, stdout then stderr, and sends
    only what fits in the run's remaining allowance, cut at a scalar boundary,
    with `{producedBytes, deliveredBytes, exceeded}` beside it;
  - past the allowance, the run ends typed and stays ended;
  - a single result past just-bash's fixed 32 MiB output bound is just-bash's
    own stop: an ordinary exit 126, never classified (the output-backstop
    exception).
- **`pipeline_width`** is checked by this module before anything runs, from
  just-bash's own parse of the script: a longer pipeline is refused whole.
  A pipeline inside `eval` or a sourced file isn't seen there.
- **`source_bytes`** is checked by the page on the script it sends, and bounds
  only that script. A sourced file (`source` or `.`) is a read, bounded by
  `read_bytes` (typed): the pinned just-bash checks `maxSourceBytes` only on
  what `exec()` is given, not on what `source` reads.
