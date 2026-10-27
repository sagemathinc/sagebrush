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
