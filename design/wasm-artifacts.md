# The WebAssembly modules as hash-pinned artifacts

Status: design, for review. No code changes yet.

The four WebAssembly modules in `wasm/` are build outputs of Rust code in `engine/`:

| module | built by | bytes at master |
|---|---|---:|
| `sagebrush-engine.wasm` | `scripts/build-engine.mjs` | 7,308,075 |
| `sagebrush-raster.wasm` | `scripts/build-raster.mjs` | 825,587 |
| `sagebrush-mp.wasm` | `scripts/build-mp.mjs` | 207,943 |
| `sagebrush-nd.wasm` | `scripts/build-nd.mjs` | 72,841 |

**Today:**
- All four are committed, so that building Sagebrush doesn't need Rust.
- `scripts/build-engine.mjs` builds all four, and CI's `engine-wasm` job runs it. `scripts/check-fresh-wasm.mjs`
  then compares all four with the committed files.
- The job uploads only `sagebrush-engine.wasm` as the run's artifact (`fresh-wasm-<sha>`). The downstream engine
  jobs overlay only that one module.
- Every engine change adds a new version of `sagebrush-engine.wasm` to the history: over master, 204 versions in
  80 MB of the packs.
- A history rewrite (section 12) removes the old versions, but only if new ones stop arriving.

**This design** keeps "building Sagebrush doesn't need Rust" and stops committing the bytes:
- git keeps a **pin** for each module: its sha256 and its exact length;
- the bytes live in our release bucket, addressed by that sha256;
- every build and test checks the bytes against the pin, or against a named, explicit alternative (section 3),
  immediately before using them.

All four modules move, under one rule.

## 1. Where the bytes live

- **The bucket:** `sagebrush-releases` (Cloudflare R2), served at `https://get.sagebrush.space`, the same
  bucket and domain the executables use (`scripts/cloudflare-setup.sh`, `release.yml`). No new service, and no
  new dependency on GitHub.
- **The key:** `wasm/sha256/<64 hex>.wasm`, content-addressed. An object is written once and never replaced:
  the same key always means the same bytes.
- **Lifetime:** kept forever. The bucket's lifecycle rule deletes `dev/` after 30 days; `wasm/` is outside it, and
  the rule must stay limited to `dev/` (a scheduled check reads it, section 8).
- **The cost:** about 7 MB per engine change that merges. These are whole files in the bucket, where git's packs
  hold each version in about 0.4 MB by delta, but in every clone.
- **Headers:** `Content-Type: application/wasm` and `Cache-Control: public, max-age=31536000, immutable`.
  CORS is already GET/HEAD from any origin.

## 2. The pin file

`wasm/pins.json`, committed, reviewed like code:

```json
{
  "v": 1,
  "modules": {
    "sagebrush-engine.wasm": { "sha256": "<64 hex>", "bytes": 7308075 },
    "sagebrush-raster.wasm": { "sha256": "<64 hex>", "bytes": 825587 },
    "sagebrush-mp.wasm":     { "sha256": "<64 hex>", "bytes": 207943 },
    "sagebrush-nd.wasm":     { "sha256": "<64 hex>", "bytes": 72841 }
  }
}
```

- **The pin is the reference.** Bytes match a pin when their length equals `bytes` exactly and their sha256
  equals `sha256`. The same rule holds everywhere: `wasm/`, the cache, an artifact, a download. The bucket, a
  cache, a mirror or a CDN in between can withhold bytes, but can't substitute them.
- Exactly these four names; an extra or missing entry is an error.
- `wasm/*.wasm` goes into `.gitignore`.
- **Size governance is unchanged:** the four modules stay direct governed rows of the size gate. Head and base
  records, ceilings and `.growth` markers stay authoritative; `bytes` in the pin is not a size budget.

## 3. Modes: which bytes a run uses

One module, `scripts/wasm-modules.mjs`, decides and checks this. Every reader calls it immediately before reading
`wasm/`:
- `web/build.ts`;
- `scripts/build-cli.mjs`;
- `cdn/build.mjs`;
- `scripts/build-all.sh`, `scripts/test-all.sh` and `scripts/ci-local.py`;
- every CI step that reads `wasm/`.

The check covers all four modules every time.

| mode | the bytes | where it is allowed |
|---|---|---|
| **pinned** | all four match `pins.json` | everywhere; the only mode for releases, packaging, publishing, the size gate, `--no-engine` builds and performance measurements |
| **fresh** | all four match the manifest of this run's own `engine-wasm` artifact: same run id and head commit, checked on download (section 4) | CI only, in the jobs named in section 4 |
| **local** | a module built on this machine, with its sidecar `wasm/<module>.local.json` (its sha256 and length, the source commit, `git status --porcelain engine/`), and the bytes match the sidecar | development only: it needs `SAGEBRUSH_WASM_LOCAL=1`, and is refused when `CI=true` |

- **Labels.** Every tool that runs in fresh or local mode prints, per module, "fresh build (pin mismatch)" or
  "local build (sha256 ..., not the pinned ...)". Unpinned bytes are never reported or recorded as pinned, and
  never as a candidate's pin.
- **State.** `build-all.sh`, `test-all.sh` and `ci-local.py` print each module's state at the start, so evidence
  names its bytes: pinned, fresh, local, or missing.
- **A missing module** is an error naming the fix: "wasm/sagebrush-engine.wasm is missing: run node
  scripts/wasm-fetch.mjs (or build it: node scripts/build-engine.mjs)". It's never a bare ENOENT.
- **Unidentified bytes** (no match with the pin, a sidecar or the install stamp of section 6) are an error.
  `wasm-fetch.mjs --force` replaces them with the pinned bytes.

## 4. CI: building, handing over and checking the modules

**The producer job, `engine-wasm`:**
- It runs before anything that reads the PR's modules.
- It installs with no fetch at all. Nothing fetches modules implicitly: there is no `postinstall` hook, and the
  fetch is an explicit step elsewhere. So a new, unpublished pin can't block the job that builds it.
- It builds all four (`build-engine.mjs`, as today), then runs today's checks.
- It writes `wasm-manifest.json`: the four names with their sha256 and length, the run id and the head commit.
- It uploads exactly those five files as one artifact, `wasm-modules-<sha>`.
- It prints, per module, the sha256 and length, and the exact `pins.json` lines to commit.

**Every job that installs the artifact:**
- checks that it holds exactly the five files;
- checks that the manifest's run id and head commit are its own run's;
- checks that every module matches the manifest;
- installs all four. Today's overlay of only the engine module goes away.

**Routing:** `ci-paths.mjs` sends everything that can change a module or its handling to `engine-wasm`:
- `engine/**`, `Cargo.*` and `engine/rust-toolchain.toml`;
- all four builders (today `build-raster.mjs` and `build-mp.mjs` are missing from `enginePaths`);
- `wasm/pins.json`;
- the pin, fetch and install tools;
- the workflow that builds the artifact.

**A static job graph.** The `changes` job decides, before anything runs, whether the PR touches those inputs.
Whether a job waits for `engine-wasm` follows from that decision, never from discovering a 404 at run time.
- **Engine inputs unchanged:** every job runs pinned, fetching the published modules (cached by `actions/cache`,
  keyed by `pins.json`'s hash). No job waits.
- **Engine inputs changed:** every job that reads `wasm/` has `needs: engine-wasm` and installs the artifact. That
  covers the engine jobs, `checks` (the size records), node-tests, web-browser and modes, all of which can exercise
  the engine. Then:
  - **the artifact matches the PR's pin:** the jobs run pinned (the artifact is the pinned bytes);
  - **it doesn't, on a pull request:** only the named engine test jobs (`engine-node`, `engine-language`,
    `engine-modes`) run, in fresh mode, labelled, to show the author what the change does. `checks` (the size
    gate), and every other reader, fail with "the pin is stale: commit the pins.json lines this run printed".
  - **it doesn't, on a dispatch (the landing gate), a master push or the schedule:** an error, as today's
    `check-fresh-wasm.mjs`.

So master never carries a pin that isn't its own source's build.

**The author's pin.** A local build with the pinned toolchain and the path mapping is byte-identical to CI's:
`build-mp.mjs`, `build-raster.mjs` and `build-all.sh` already map the cargo home to `/home/runner/.cargo`, and
`build-engine.mjs` and `build-nd.mjs` will do the same. So an author with Rust can commit the pin with the code
change (`node scripts/wasm-pins.mjs --from-local`), and the first CI run is already pinned. Without Rust,
`--from-ci <run id>` takes the pin from the run's artifact (with `gh`), and the second run is pinned.

**The cost.** On a PR that changes engine inputs, the readers wait for `engine-wasm`, 2.5 to 3.8 min in recent master runs. Today only
the engine jobs wait. The implementation reports the effect on the whole run (section 10).

**Other workflows.** An artifact belongs to one workflow run, and a job can't `needs:` a job in another
workflow. So the producer is a reusable workflow, `.github/workflows/wasm-modules.yml` (`on: workflow_call`), and
every workflow that reads `wasm/` calls it first. Each run has its own artifact; nothing is handed across runs, and
there's no race with `wasm-publish`.

- **Inputs:** whether this run must build (`ci.yml` passes its `changes` decision; the others pass nothing).
- **What it does:**
  - **must build, or a pin isn't published yet** (a `HEAD` per pin, made by the producer itself, never by a
    consumer): it builds all four, as `engine-wasm` does;
  - **otherwise:** it fetches the four published modules and checks them.

  Either way it writes the manifest and uploads `wasm-modules-<sha>` for its own run.
- **Outputs:** the mode (`pinned`, or `fresh` with the mismatch), for the callers' labels.
- **Strictness:** outside `ci.yml`'s named engine test jobs on a pull request, a build whose bytes don't match the
  pins fails the producer (section 3).

| workflow | reads `wasm/` | change |
|---|---|---|
| `ci.yml` | most jobs | `engine-wasm` becomes a call of the producer |
| `app.yml` (desktop page, on PRs and master pushes for `wasm/**` and more) | `pnpm run build`, `build-cli.mjs`, `web/build.ts` | calls the producer; its path filter's `wasm/**` becomes `wasm/pins.json` |
| `app-mobile.yml`, `app-mobile-selftest.yml`, `app-ios-selftest.yml` | `build-cli.mjs`, `web/build.ts` | call the producer; their path filters (app files only, today) are unchanged |
| `optional.yml` | `build-cli.mjs` | calls the producer |
| `nightly.yml` (schedule) | `build-cli.mjs`, `web/build.ts` | calls the producer |
| `release.yml` (`v*` tags) | `build-cli.mjs`, `web/build.ts`, `cdn/build.mjs` | calls the producer; a tag's commit is on master, so its pins are published and fetched, and anything else fails |
| `pypi.yml`, `pypi-mcp.yml`, `install-timing.yml`, `app-ios-generate.yml` | no | none |

**The cost:** a workflow other than `ci.yml` that runs on an engine PR builds the modules itself (as long as `engine-wasm`,
2.5 to 3.8 min in recent master runs). On a PR without engine changes it fetches, with no wait. Section 10 measures both.

**No pull request run uploads anything to the bucket.** Pull request runs, forks included, have no bucket
credentials.

## 5. Publishing, on a push to master

A new job, `wasm-publish`:
- **Where it runs:** only for `push` to `master` in `sagemathinc/sagebrush`. It runs in a GitHub environment,
  `wasm-publish`, whose deployment branches are `master` only and which holds the bucket credentials.
  `concurrency: wasm-publish`, never cancelled.
- **Its bytes:** `needs: engine-wasm` of the same run. It takes that run's artifact, checks the manifest (this run,
  this commit), and checks that all four modules match `pins.json`. Otherwise it stops.
- **For each of the four pins:** a bounded GET of the key (section 6's limits).
  - **Present:** its length and sha256 must match the pin. A key that doesn't match fails the job loudly, and is
    never overwritten.
  - **Absent:** upload it with a conditional write (only if the key doesn't exist), then GET it back from
    `get.sagebrush.space` and check its length and sha256.
- **It succeeds** only when all four keys have been read back and match.
- **Afterwards**, in the same run, `wasm-pins.mjs --verify-published` (`needs: wasm-publish`) checks master's pins
  again from a cold client.

**The first publication.** The four current modules are published once, before any pin depends on the bucket:
- by a `workflow_dispatch` of the same workflow, on ref `master` only (the environment's branch rule enforces
  that);
- its `engine-wasm` builds the modules in that run and checks them against the committed files and `pins.json`;
- `wasm-publish` then runs as above.

This is the only exception to "push to master", and the dispatch stays as the repair path for a failed publish.

**The credentials.** Today the bucket credentials (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) are
repository-level secrets, and `release.yml`'s job has no environment. As part of step 2 of the rollout:
- they move into two environments, `wasm-publish` and `releases`, each limited to its ref (`master`, and `v*` tags);
- the repository-level copies are deleted;
- `gh secret list` at repository level then shows none of them.

A maintainer makes these changes.

## 6. Getting the modules: `scripts/wasm-fetch.mjs`

An explicit step, never a hook: run by a developer (`pnpm wasm`), by `build-all.sh` and `test-all.sh`, and by the CI
fetch step. One process handles all four modules: each at most once, at most two downloads at a time. No reader
fetches on its own.

**For each module:**
1. **`wasm/<module>` already matches the pin:** done. It's still hashed (a local read of up to 7.3 MB), with no
   network.
2. **It's bytes the script installed for an earlier pin** (an ordinary branch switch): replace it from the cache,
   or the network.
   - The script records what it installs in `wasm/.installed.json` (module, sha256, length). Bytes matching that
     record are known to be ours and are replaceable.
   - Bytes that match neither the pin, nor that record, nor a local sidecar are unidentified: an error
     (section 3).
3. **The user cache has the pinned bytes** (`$XDG_CACHE_HOME/sagebrush/wasm/<sha256>.wasm`, default
   `~/.cache/...`; length and sha256 checked): copy them in. No network.
4. **Otherwise download** from `https://get.sagebrush.space/wasm/sha256/<sha256>.wasm`. `SAGEBRUSH_WASM_BASE`
   overrides the URL, for a mirror or a local directory, under the same checks.

**Limits:**
- 10 s to connect, 60 s per download in total;
- the download is cut off past the pinned length;
- up to 3 attempts for a network error or a 5xx, with backoff of 1 s, then 4 s;
- a 404 isn't retried. It says: "this pin isn't published yet: it was merged in the last few minutes, or it
  comes from an unmerged pull request: build it (node scripts/build-engine.mjs), or use that run's artifact";
- nothing about a 404 is remembered, so the next run succeeds once the pin is published;
- **the whole script has a 240 s deadline.** After it, it fails, naming each unfinished module, its URL and its last
  error;
- `--offline` makes no network request at all: a miss fails at once.

**Concurrent runs** (worktrees and jobs sharing one cache):
- each download goes to a unique temp file in the cache directory (`<sha256>.<pid>.<random>.part`);
- it's checked (length, then sha256) before anything else sees it;
- it's committed with an atomic rename onto `<sha256>.wasm`. Two runs fetching the same hash both end with the same
  checked bytes;
- `wasm/<module>` is written the same way, temp then rename, mode 0644 (as `install-engine-wasm.mjs` does today);
- no reader ever sees a partial file;
- a `.part` older than an hour is removed.

**Developing without Rust:** `pnpm wasm` once. A new engine version costs one download, about 7.3 MB. Switching
to a branch whose pins are cached needs no network, only a local hash and copy. Switching to one with uncached pins
downloads them.

**Developing with Rust:**
- the builders write the module and its sidecar;
- tools accept it only with `SAGEBRUSH_WASM_LOCAL=1`, and say so;
- `wasm-fetch.mjs --force` restores the pinned bytes;
- `node scripts/wasm-pins.mjs --check` prints each module's state.

**Offline:** works for pins already in the cache. A pin that isn't cached fails at once with `--offline`, or within
the limits without it.

## 7. Who reads `wasm/`, and what changes

| reader | today | after |
|---|---|---|
| `web/build.ts` (the page; it records each module's sha256 for the page's own check) | the committed files | a mode check first (section 3); the recorded sha256 is unchanged |
| `scripts/build-cli.mjs` (`build/cli/pyjs.cjs` embeds the modules as base64; the npm package `sagebrush`) | the committed files | the same; pinned only, for a release |
| `cdn/build.mjs` (the npm package `sagebrush-web`, whose modules are build outputs) | the committed engine | the same; `--check` runs pinned |
| `src/runtime/*.ts` Node fallback (`wasm/` beside the source) | the committed files | the fetched files |
| `app.yml` and the mobile and optional workflows (pages and the CLI bundle) | the committed files | the producer's artifact, pinned (section 4) |
| `release.yml` (executables, npm) | the committed files | the producer, pinned: a tag's build uses exactly its published pins |
| PyPI (`pypi.yml`, `pypi-mcp.yml`) | doesn't read `wasm/` (native extension) | unchanged |
| CI jobs | the committed files; the engine jobs overlay the fresh engine module | section 4 |
| `scripts/ci-local.py`, `scripts/test-all.sh`, `scripts/build-all.sh` | the committed files; `ci-local.py` restores the committed engine after its own build, and `build-all.sh` reports whether its fresh engine matches the committed one | fetch first and print each module's state; both compare with the pin instead |
| the size gate (`size-base`, `checks`) | `web/dist`, built from the committed files | `size-base`: the base commit's published pins; `checks`: the head's pinned modules (section 4). Same bytes, same governed rows. |
| tests that read `wasm/` (`test/engine-retire.test.ts`, `test/png.test.ts`, `test/nd-wasm.test.ts`, `engine/web/tests/wasm_designated.mjs`, `engine/bench/run_wasm.cjs`) | the committed files | the files of the run's mode |

## 8. Checks, and their planted controls

| today | after |
|---|---|
| `check-fresh-wasm.mjs`: the fresh build equals the committed bytes (an error on master, a dispatch or the schedule; a warning on a PR) | the fresh manifest equals the pins, with section 4's event policy |
| `build-all.sh`: "byte-identical to the committed wasm" | "matches the pin" |
| `cdn/build.mjs --check`: builds from the committed wasm | builds from the pinned wasm |
| none | `wasm-pins.mjs --verify-published` on master pushes (after `wasm-publish`) and on the schedule: every pin at master's tip is in the bucket, with matching length and sha256 |
| none | the scheduled check also reads the bucket's lifecycle rule: it covers only `dev/` |
| `ci-paths.mjs`: `wasm/**` and two of the four builders | section 4's routing |

**Planted controls** (`wasm-pins.mjs --self-test`, which runs in CI), each a fixture that must fail with its own
message:
- **the fetch:**
  - wrong bytes with the right length;
  - the right sha256 with an extra byte;
  - an oversized download;
  - a 404;
  - an unreachable origin (fails within the limits);
  - `--offline` with a miss;
  - unidentified bytes in `wasm/`;
  - a sidecar that doesn't match its module;
- **the artifact:**
  - one member removed, for each of the four;
  - an extra file;
  - a corrupted member;
  - a manifest from another run or commit;
- **the event policy:**
  - a stale pin is a warning on a PR fixture;
  - and an error on push, dispatch and schedule fixtures;
- **publishing:**
  - `--verify-published` against a missing key;
  - and against a key with wrong bytes;
  - the publish read-back against a stubbed bucket that returns different bytes;
- **the lifecycle check:** a rule covering `wasm/` must fail;
- **a branch switch:**
  - bytes installed for an earlier pin are replaced from the cache with no network;
  - unidentified bytes are refused.

## 9. Security

- **The pin, in git, is the reference.** A pin changes only through a reviewed pull request, and the landing gate
  requires it to be that PR's own build. Content addressing means the bucket can't swap bytes: a substituted
  object fails the length and sha256 check everywhere it's read. A compromised bucket can only withhold modules,
  and the scheduled check notices.
- **Unpinned bytes** (fresh or local mode) never reach a release, a package, the bucket, the size records or a
  performance measurement (section 3).
- **Write access:** only `wasm-publish`, in its environment, on `master` (and its dispatch on `master`), can write.
  It never overwrites a key, and it checks every key by reading it back.
- **No new execution path.** The page already loads modules by URL only with their sha256
  (`src/runtime/wasm-asset.ts`; design/security.md, SEC-522-1). The same rule now applies at build time, and the
  page's runtime check is unchanged.

## 10. Measurements the implementation reports

Each with network bytes, request count, wall time, and hash and copy time:
1. a cold cache with published pins;
2. a warm hit;
3. a branch switch with existing modules, hit and miss;
4. offline, hit and miss (`--offline` and without);
5. two concurrent fetches of the same pins into one cache;
6. a PR with engine changes: the artifact's handoff in `ci.yml`, and the producer's own build in `app.yml`;
7. an unreachable origin: the time to fail, per module and for the whole script (deadline 240 s).

Also whole-CI wall time and the critical path, before and after, on a PR with engine changes and one without.

None of this changes the app at runtime: its loading and checks are unchanged, so this design makes no claim about
the app's speed.

## 11. Rollout (each step a pull request with the usual lanes)

1. **This design.**
2. **Scripts and CI, with the bytes still committed:**
   - `wasm/pins.json`;
   - `wasm-modules.mjs`, `wasm-fetch.mjs` and `wasm-pins.mjs`;
   - the producer's artifact and manifest;
   - the routing and job graph;
   - `wasm-publish` and its environment;
   - the credentials' move into environments;
   - the checks and their controls.

   The fetch steps are no-ops while the committed files match the pins. The first publication (section 5) runs
   after it lands, and `--verify-published` goes green.
3. **Stop committing:** `git rm --cached wasm/*.wasm`, `.gitignore`, and the docs (`DEVELOPMENT.md`, `README.md`).
   From here an engine pull request commits its pin. Pull requests in flight that carry a module change drop the
   bytes and commit the pin instead (a modify/delete conflict, resolved by deletion).
4. **The history rewrite** (section 12), once step 3 has landed and the queue is empty.

Steps 2 and 3 change workflow files, so a maintainer pushes them.

## 12. Runbook: the one-time history rewrite

Strip, in one pass:
- every version of `cdn/sagebrush-engine.mjs` (no longer tracked);
- every version of `wasm/*.wasm` (no longer tracked after step 3).

**Measured** in a dry run on a scratch mirror clone of GitHub (`git filter-repo` 2.47.0, packs after a full
repack; the log is kept with the review):

| what a clone holds | today | `.mjs` removed | `.mjs` and every `wasm/*.wasm` removed |
|---|---:|---:|---:|
| master only (at a119fa40) | 374.75 MiB | 119.83 MiB | 45.33 MiB |
| all branches and tags (what `git clone` fetches; 1,046 branches, 36 tags) | 430.57 MiB | 139.01 MiB | 55.27 MiB |

Removing the `.mjs` changes 1,071 refs: every tag, and every branch whose history contains the file.

**Before:**
1. **Announce a freeze** to every contributor: the date, the time and the expected length. From its start: no
   pushes, no merges, and no publishing (below).
2. **Drain the queue:** every open PR is merged or explicitly parked. A parked PR is re-created after the rewrite
   from its diff (`git diff <old base>..<head>`, applied to the new master).
3. **Freeze publishing:**
   - Disable every workflow a ref update can start (`release.yml`, `pypi.yml`, `pypi-mcp.yml`, the app workflows and
     `ci.yml`) with `gh workflow disable`, and hold `wasm-publish`: its environment requires a reviewer's approval
     until the end.
   - Wait until no run is queued or in progress.
   - Rewritten tags are pushed as tag updates. Nothing may rely on GitHub skipping events when many tags are pushed
     at once.
4. **Back up:**
   - a `git clone --mirror` of GitHub;
   - `git bundle create sagebrush-pre-rewrite.bundle --all`, with its sha256 recorded.

   It's stored in two places:
   - a private bucket with no public domain and no public URL, separate from `sagebrush-releases`, after checking
     that an anonymous GET of the bundle's key is refused;
   - one more copy outside Cloudflare.

   Check that the bundle clones and that its master equals GitHub's.
5. **Delete merged branches:** branches whose tip is an ancestor of master, plus abandoned agent branches, by an
   explicit list that a maintainer approves. Fewer refs to rewrite.
6. **Inventory the commit SHAs that files use.** Search tests, scripts and fixtures for SHAs passed to git
   (`git show`, `rev-parse`, `cat-file`, and fields like `"commit"` and `"rev"`). Known so far:
   - `test/arraybuffer-sites.base.json`'s `header.commit` (`bc239487...`), which
     `test/arraybuffer-sites.test.ts` recomputes and fetches;
   - `b06b01b7` in `web/share/test-share.mjs` and `web/cloud/share/test-share.mjs`, which print SKIP without it;
   - `test/limit-sweep/manifest.json`'s `rev` (`279b16e6...`).

   Each one is mapped through the commit map in the first commit after the rewrite (below).
7. **Write the ref inventory:** every branch and tag to update, with its old OID (from the mirror) and its new OID
   (from the rewrite). A maintainer approves it.

**The rewrite**, on a fresh mirror clone (filter-repo refuses a non-fresh one):
```
git filter-repo --path cdn/sagebrush-engine.mjs --path-glob 'wasm/*.wasm' --invert-paths
```
`wasm/pins.json` doesn't match that glob and survives.

**Check before pushing:**
- **every ref in the inventory, not only master:** in a scratch repository holding both the old objects (the
  bundle) and the new ones, `git diff --name-only <old> <new>` lists only the stripped paths, and every commit's
  tree is otherwise identical;
- `git fsck --full`;
- a pinned build from the rewritten master passes (`wasm-fetch.mjs`, then `build-all.sh --no-engine`);
- the commit map (`filter-repo/commit-map`) is kept with the backup.

**Push, by a maintainer:**
- Each ref is pushed from the inventory with its lease: `git push --force-with-lease=<ref>:<old OID> origin
  <new OID>:<ref>`. One ref per lease; a lease that fails stops the run.
- After the push, every remote ref is compared with the inventory's new OID.
- **Rollback:** the same inventory pushes the old OIDs back, from the bundle, with leases on the new OIDs.
- GitHub's `refs/pull/*` can't be rewritten. GitHub keeps the old objects for them, but `git clone` doesn't fetch
  them, so clones are small. Shrinking GitHub's own storage needs a request to GitHub support, which is optional.

**After, in three stages.**

**Stage 1: still frozen.** Publishers stay disabled and drained.
1. **The first commit on the new master** maps the inventoried SHAs (before, item 6) through the commit map. A
   maintainer pushes it with a lease.
2. **Re-enable `ci.yml` only, with publishing held:**
   - `wasm-publish`'s environment still requires approval, and no one approves it;
   - `release.yml`, `pypi.yml`, `pypi-mcp.yml` and the app workflows stay disabled.

   Run `ci.yml` on the new master by dispatch. It must be green, and the inventoried tests must have run, not
   SKIP.
3. **Read-only checks that don't depend on any publisher:**
   - `wasm-pins.mjs --verify-published` against master's pins (the bytes were published before the rewrite, and the
     pins didn't change);
   - every remote ref compared with the ref inventory.

**Stage 2: restore publishing.**
1. Remove the approval requirement on `wasm-publish`'s environment, and re-enable the release, PyPI and app workflows.
2. Check that no run was started by the rewritten tags or branches while they were disabled. Cancel any that was,
   before it publishes; a rewritten `v*` tag must not publish a release again.
3. The next ordinary master push runs `wasm-publish`, which finds every key already present and matching.

**Stage 3: lift the freeze**, and then:
- **Every clone re-clones**, every agent's and every human's. The shared `.git` in the project is replaced, not
  fetched into: old objects mixed into new history would bring the size back. Worktrees are recreated.
- **Tags:** all of them are rewritten and keep their names. Published packages (npm `gitHead`, PyPI) keep pointing
  at old SHAs; the commit map and the backup bundle answer "which new commit is that".
- **SHAs cited elsewhere** (PR bodies, reviews, `.growth` markers' reasons, memory notes, the dashu fork's
  references, the jsdelivr diagnostic's `7dddf961`) stay valid in the backup bundle. A note in `DEVELOPMENT.md`
  gives the rewrite date and where the commit map is.
