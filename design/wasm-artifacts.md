# The WebAssembly modules as hash-pinned artifacts

Status: design, for review. No code changes yet.

The four WebAssembly modules in `wasm/` are build outputs of Rust code in `engine/`:

| module | built by | size now |
|---|---|---:|
| `sagebrush-engine.wasm` | `scripts/build-engine.mjs` | 7.3 MB |
| `sagebrush-raster.wasm` | `scripts/build-raster.mjs` | 0.8 MB |
| `sagebrush-mp.wasm` | `scripts/build-mp.mjs` | 0.2 MB |
| `sagebrush-nd.wasm` | `scripts/build-nd.mjs` | 0.07 MB |

Today all four are committed, so that building Sagebrush doesn't need Rust. Every engine change adds a new 7.3 MB
version of `sagebrush-engine.wasm` to the history. Over master's history it has 204 versions, 80 MB of the packs.
A history rewrite (section 9) removes the old versions, but only if new ones stop arriving.

This design keeps "building Sagebrush doesn't need Rust" and stops committing the bytes. Git keeps a **pin**, the
sha256 of each module. The bytes live in our release bucket, addressed by that sha256, and every consumer checks
the hash before using them.

## 1. Where the bytes live

- **The bucket:** `sagebrush-releases` (Cloudflare R2), served at `https://get.sagebrush.space`, the same
  bucket and domain the executables use (`scripts/cloudflare-setup.sh`, `release.yml`). No new service, and no
  new dependency on GitHub.
- **The key:** `wasm/sha256/<64 hex>.wasm`, content-addressed. An object is written once and never replaced:
  the same key always means the same bytes.
- **Lifetime:** kept forever. The bucket's lifecycle rule deletes `dev/` after 30 days; `wasm/` is outside it, and
  the setup script's rule must stay limited to `dev/` (a check in section 6 reads the rule).
  The cost is about 7 MB per engine change, which is what git stores today, but outside every clone.
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

- **The pin is the trust root.** A module is used only if its sha256 equals the pin. The bucket, a cache, a
  mirror or a CDN in between can withhold bytes, but can't substitute them.
- `bytes` lets a reader refuse an oversized download before hashing it, and makes size changes visible in the
  diff.
- `wasm/*.wasm` goes into `.gitignore`.

## 3. A pull request that changes engine Rust

The bytes a pin names must be CI's build. The engine's module embeds crate source paths, and CI's runner is the
reference: `scripts/build-mp.mjs` and `build-all.sh` already map the cargo home to `/home/runner/.cargo` for
that reason.

1. **The author changes `engine/`.** With Rust, they build locally as now, and their local tools use the local
   build (section 4).
2. **CI's `engine-wasm` job builds fresh modules, as today.** It uploads them as the run's GitHub artifact
   (`fresh-wasm-<sha>`), and the downstream `engine-*` jobs test those bytes, as today. The job also prints, for
   each module, the sha256 and byte count, and the exact `pins.json` lines to commit.
3. **The author commits the new pin.** It's a two-line text diff instead of a 7 MB binary. `node
   scripts/wasm-pins.mjs --from-ci <run id>` can write it: it downloads the run's artifact with `gh`, hashes it and
   edits `pins.json`.
4. **The check, the same policy as `check-fresh-wasm.mjs` today:** CI compares each fresh module's sha256 with
   the pin. A mismatch on a pull request is a **warning** (mid-review it's expected). On a dispatch (the train's
   gate before landing), a master push or the schedule it's an **error**: master never carries a pin that isn't
   its own source's build.
5. **No pull request run uploads anything.** Pull request runs, forks included, have no bucket credentials.
   Until merge, the pinned bytes exist only as that run's GitHub artifact, and a reviewer who wants them uses
   that artifact, as today.

**On merge (a push to master).** A new job, `wasm-publish`:
- runs only for `push` to `master` in `sagemathinc/sagebrush`, in a GitHub environment that holds the R2
  credentials;
- needs `engine-wasm` from the same run, and takes its artifact;
- checks that every module's sha256 equals its pin, and stops otherwise;
- uploads each module whose key isn't in the bucket yet (`HEAD` first; an existing key is never rewritten);
- fetches each one back from `get.sagebrush.space` and checks its sha256.

For a pin that didn't change, it only does the `HEAD` check. `engine-wasm` runs on every master push, so the
job always has fresh bytes to compare.

**The window between merge and publish** is a few minutes. A fetch of a pin that isn't published yet fails with a
message that says so (section 4). The landing train merges one PR at a time, so no later PR builds on an unpublished pin
before its own CI has built it.

## 4. Getting the modules: `scripts/wasm-fetch.mjs`

One script, run before anything reads `wasm/`. For each module in `pins.json`:

1. **`wasm/<module>` already has the pinned sha256:** done.
2. **The user cache has it** (`$XDG_CACHE_HOME/sagebrush/wasm/<sha256>.wasm`, default `~/.cache/...`, sha256
   checked): copy it in.
3. **Otherwise download it** from `https://get.sagebrush.space/wasm/sha256/<sha256>.wasm`:
   - refuse more than the pinned `bytes`;
   - check the sha256;
   - write it to the cache, then install it with `install-engine-wasm.mjs`'s atomic 0644 write.
   A 404 says: "this pin isn't published yet: it was merged in the last few minutes, or it comes from an
   unmerged pull request: build it (node scripts/build-engine.mjs), or take that run's fresh-wasm artifact".

`SAGEBRUSH_WASM_BASE` overrides the URL, for a mirror or a local directory. The sha256 check is the same either
way.

**Developing without Rust:** `pnpm install` (a `postinstall` step) or `scripts/build-all.sh --no-engine` runs
`wasm-fetch.mjs`. One download per engine version, and the cache makes switching branches free.

**Developing with Rust:** `build-engine.mjs` (and its three siblings) writes `wasm/` as now. Afterwards
`wasm-fetch.mjs` finds a module that doesn't match the pin. It leaves it in place and says so (a local build
wins); `--force` replaces it with the pinned bytes. `node scripts/wasm-pins.mjs --check` prints, per module:
pinned, a local build, or missing.

**Offline:** after one fetch the cache serves every later checkout, a worktree included. The tests that read `wasm/`
(`test/engine-retire.test.ts`, `test/png.test.ts`, `test/nd-wasm.test.ts`, `engine/web/tests/wasm_designated.mjs`,
`engine/bench/run_wasm.cjs`) and the offline inventory (`web/test-offline-inventory.mjs`, which reads the
built page) are unchanged: they read files that `wasm-fetch.mjs` put there.

## 5. Who reads `wasm/`, and what changes

| reader | today | after |
|---|---|---|
| `web/build.ts` (the page; it records each module's sha256 for the page's own check) | the committed files | runs `wasm-fetch.mjs` first; the recorded sha256 is unchanged |
| `scripts/build-cli.mjs` (`build/cli/pyjs.cjs` embeds the modules as base64; the npm package `sagebrush`) | the committed files | the same |
| `cdn/build.mjs` (the npm package `sagebrush-web`; #1047 makes its modules build outputs) | the committed engine | the same; `--check` hashes against the pin |
| `src/runtime/*.ts` Node fallback (`wasm/` beside the source) | the committed files | fetched files |
| `app.yml` (the desktop app, via `web/dist`) | the committed files | a fetch step before the build |
| `release.yml` (executables, npm) | the committed files | a fetch step; a tag's build uses exactly its pins |
| PyPI (`pypi.yml`, `pypi-mcp.yml`) | doesn't read `wasm/` (native extension) | unchanged |
| CI jobs other than the engine jobs (node-tests, web-browser, modes, ...) | the committed files | a fetch step (cached by GitHub's `actions/cache`, keyed by `pins.json`'s hash) |
| CI engine jobs | the run's fresh build | unchanged |
| `scripts/ci-local.py`, `test-all.sh`, `build-all.sh` | the committed files; they guard against overwriting them | fetch first; "local changes to the committed wasm" becomes "a local build differs from the pin" |
| the size gate (`size-base`, `checks`) | `web/dist`, built from the committed files | built from fetched files: the same bytes, so the same rows |

**Pull requests whose pin isn't published:** in that PR's own CI, every job takes the run's `fresh-wasm-<sha>`
artifact instead of fetching. The engine-wasm job already uploads it, and the engine jobs after it download it;
this extends the download to every job that reads `wasm/` when `wasm-fetch.mjs` reports an unpublished pin. The size gate's
`size-base` builds the base commit, whose pins are published (it's master), so it fetches.

## 6. Checks that replace the stale-committed-wasm checks

| today | after |
|---|---|
| `check-fresh-wasm.mjs`: the fresh build equals the committed bytes (an error on master, a dispatch or the schedule; a warning on a PR) | the fresh build's sha256 equals the pin, with the same event policy |
| `build-all.sh`'s "byte-identical to the committed wasm" | "byte-identical to the pin" |
| `cdn/build.mjs --check` (#1047: builds from the committed wasm) | builds from the fetched, pin-checked wasm |
| none | **`wasm-pins.mjs --verify-published`** on master pushes and the schedule: every pin at master's tip is in the bucket, and its bytes hash to the pin. It catches a failed or skipped publish. |
| none | **`wasm-pins.mjs --self-test`**: a wrong hash, an oversized download and a 404 each fail with their own message (planted controls, so a check that silently passes is caught) |
| none | the setup script's lifecycle rule covers only `dev/` (the scheduled check reads it), so pinned bytes never expire |
| `ci-paths.mjs`: `wasm/**` is a build input | `wasm/pins.json` is; a pin change runs the engine jobs |

## 7. Security

- **The pin, in git, is what's trusted.** A pin changes only through a reviewed pull request, and the dispatch
  gate requires it to be that PR's own build. Content addressing means the bucket can't swap bytes: a substituted
  object fails the sha256 check everywhere it's read. A compromised bucket can only withhold modules, and CI
  notices that (`--verify-published`).
- **Write access:** only `wasm-publish` on master pushes in `sagemathinc/sagebrush` can write, through a GitHub
  environment whose secrets aren't available to pull request runs. These are the existing R2 credentials, which
  can only touch objects in that one bucket. `release.yml` keeps its own use.
- **No new execution path.** The page already loads modules by URL only with their sha256
  (`src/runtime/wasm-asset.ts`, SEC-522-1). The same rule now applies at build time, and the page's runtime
  check is unchanged.
- **Size limits:** a download is cut off at the pinned `bytes`.

## 8. Rollout (each step a pull request with the usual lanes)

1. **This design.**
2. **Scripts and CI, the bytes still committed:**
   - `wasm/pins.json` (the current four modules);
   - `wasm-fetch.mjs` and `wasm-pins.mjs`;
   - the `wasm-publish` job;
   - the fetch steps (no-ops while the files are present and match);
   - the new checks.
   A one-time `workflow_dispatch` of `wasm-publish` uploads the current four modules. After it,
   `--verify-published` is green.
3. **Stop committing:** `git rm --cached wasm/*.wasm`, `.gitignore`, and the docs (`DEVELOPMENT.md`, `README.md`).
   From here an engine pull request commits its pin. Pull requests in flight that carry a wasm change drop the
   bytes and commit the pin instead (a modify/delete conflict, resolved by deletion).
4. **The history rewrite** (section 9), once step 3 has landed and the queue is empty.

The workflow files change in steps 2 and 3, so @sagebrush pushes those.

## 9. Runbook: the one-time history rewrite

Strip, in one pass:
- every version of `cdn/sagebrush-engine.mjs` (#1047 untracks it);
- every version of `wasm/*.wasm` (step 3 untracks them).

Measured in a dry run on a scratch mirror (`git filter-repo`, a pack after full repack):

| what a clone holds | today | `.mjs` removed | `.mjs` and every committed `.wasm` removed |
|---|---:|---:|---:|
| master only | 374.8 MiB | 119.9 MiB | under 59.4 MiB* |
| all branches and tags (what `git clone` fetches) | 430.6 MiB | 139.0 MiB | under 96.2 MiB* |

\*The dry run kept the engine module at each ref's tip. After step 3 the tips have no module, so the result is
smaller still.

**Before:**
1. **Announce a freeze:** date, time and expected length, to every agent and to William. No pushes and no merges
   from its start.
2. **Drain the queue:** every open PR is merged or explicitly parked. A parked PR is re-created after the rewrite
   from its branch's diff: `git diff <old base>..<head>`, applied to the new master.
3. **Back up:**
   - `git clone --mirror` of GitHub;
   - `git bundle create sagebrush-pre-rewrite.bundle --all` from it, with its sha256 recorded;
   - the bundle stored in the bucket under `backups/` (private, not served) and in one more place.
   Check that the bundle clones and that its master equals GitHub's.
4. **Delete merged branches first:** branches whose tip is an ancestor of master, plus abandoned agent branches,
   by an explicit list that @sagebrush approves. Fewer refs to rewrite; it saved about 56 MiB of the 430.6 MiB in
   the dry run.

**The rewrite**, on a fresh mirror clone (filter-repo refuses a non-fresh clone):
```
git filter-repo --path cdn/sagebrush-engine.mjs --path-glob 'wasm/*.wasm' --invert-paths
```
- `wasm/pins.json` is not matched by that glob and survives.
- Check before pushing:
  - master's tip tree is identical to the old tip's (step 3 already removed the files);
  - `git fsck --full`;
  - a CI-equivalent local build from the rewritten master (`wasm-fetch.mjs`, then `build-all.sh --no-engine`)
    passes;
  - the old-SHA to new-SHA map is kept (`filter-repo/commit-map`).
- **Push**, by @sagebrush: `git push --force --mirror` of branches and tags. GitHub's `refs/pull/*` can't be
  rewritten. GitHub keeps the old objects for them, but `git clone` doesn't fetch them, so clones are small.
  Shrinking GitHub's own storage needs a request to GitHub support, which is optional.

**After:**
- Every agent and every human clone **re-clones**. The shared `.git` in the project is replaced, not fetched into:
  old objects mixed into new history would bring the size back. Worktrees are recreated.
- **Tags:** all 36 are rewritten, and they keep their names. Published packages (npm `gitHead`, PyPI) keep pointing at old SHAs. The
  commit map and the backup bundle answer "which new commit is that".
- **SHAs cited elsewhere** (PR bodies, reviews, `.growth` markers' reasons, memory notes, the dashu fork's
  references, the jsdelivr diagnostic's `7dddf961`) stay valid in the backup bundle. A note in `DEVELOPMENT.md`
  gives the rewrite date and where the commit map is.
- **Lift the freeze** after CI is green on the rewritten master and `wasm-pins.mjs --verify-published` passes.
