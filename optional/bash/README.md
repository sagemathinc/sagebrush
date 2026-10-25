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
- `{rejected: {message, refusal: null}}`: just-bash's `exec()` rejected. This
  is never folded into an exit status. Step 2 adds the refusal's id.

If the shell is gone (terminated, its worker failed, or its protocol broke),
`exec()` rejects with `ShellUnavailableError`: every pending call, and every
later one at once.
