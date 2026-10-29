# Branch previews on sagebrush.cloud

This packet provides a static preview Worker, a publisher, and a shared mock switch.
It does not deploy the Worker, create an R2 key, publish a preview, or implement any
lane's fake backend. The initial hosted target is `https://latex.sagebrush.cloud/?latex=1`.

## First preview and review gates

The manager deploys `web/preview/cloudflare.config.ts` only after security review by astra3
and astra5 and limits review by daybreak2. It has one native bucket binding,
`PREVIEWS` -> `sagebrush-preview`, no secret bindings, and no origin server. Its
route is `*.sagebrush.cloud/*`; the apex is not an app. The previously configured
14-day R2 object lifecycle also expires policy sidecars.

The deploy command is `cf deploy` from `web/preview/`. It uses
`cloudflare.config.ts`, whose entry imports **only** the default Worker from
`entry.mjs`. Directly using worker.mjs exposes helper exports; Cloudflare rejects
its exported null-prototype MIME table. The wrapper preserves the reviewed Worker
object without changing its serving behavior. `wrangler` 4.155.0 is pinned in this
package and package-lock.json. The installed `cf` 1.0.0-beta.12 package must also
resolve as `cf/config` from this directory (the deployment used a local
node_modules/cf symlink to the installed CLI package). A global cf executable
alone does not ensure ESM package resolution. No new install was run here.
`wrangler.jsonc` remains an equivalent route/binding reference, not the cf deploy
configuration.

**Native binding limitation:** Cloudflare's R2 binding exposes read and write
methods. Wrangler does not offer a read-only flag for this binding. This Worker
only calls `get`; it has no write handler, account API calls or outbound `fetch`.
This is read-only application code, not a platform-enforced read-only credential.
Security review must accept that distinction before deployment. A hard permission
boundary would require a different design (for example a read-only S3 credential,
which conflicts with the no-secrets Worker requirement).
Sources: [Workers binding capability](https://developers.cloudflare.com/workers/runtime-apis/bindings/),
[R2 Workers API](https://developers.cloudflare.com/r2/get-started/workers-api/).

LaTeX batch 2 is still owned by the LaTeX lane. It was not pulled into this packet.
Their reviewed host-gate change must read `SAGEBRUSH_PREVIEW_HOST` for hosted
`SAGEBRUSH_LATEX_PREVIEW=1` builds and allow exactly `latex.sagebrush.cloud` while
retaining the user's `?latex=1` opt-in. They confirmed that `=test` enables test-only
hooks and must not be hosted. The publisher refuses `=test`, and refuses a LaTeX
build script without `SAGEBRUSH_PREVIEW_HOST`. This string check is a helpful
preflight, not proof that the lane's host gate works. The lane's review, build
proof, and push authorization remain prerequisites for the first batch-2 preview.

## Publishing after the pipeline is approved

Use this project with Node 22+, Bun, installed repository
packages and the normal pinned wasm inputs. Each of the three build subprocesses runs through the approved
`/home/user/sagebrush-coord/bin/ptest -m 30 --` wrapper. Preparation, credential
loading and R2 requests stay in the publisher parent, outside that wrapper. This script deliberately
runs no tests, package install, Rust build or deployment tool. It invokes:

```sh
node_modules/.bin/tsc -p .
node scripts/build-cli.mjs
bun web/build.ts
```

Cherry-pick the preview packet commit into the lane's public Sagebrush checkout,
then run its own script there. It builds that checkout (including local changes),
not the manager's master, and deletes its old `web/dist` first. Use a dedicated
worktree; it owns `web/dist` and the normal compiler/CLI generated files there.
`SAGEBRUSH_NO_SITE=1` ensures a `web/site` overlay is not built or uploaded.
Normal build prerequisites, including current third-party notices, must already
hold; a build failure prevents any upload.

```sh
scripts/preview.sh latex SAGEBRUSH_LATEX_PREVIEW=1
scripts/preview.sh agents SAGEBRUSH_PREVIEW_MOCKS=agent-feed,journal-active
scripts/preview.sh kernels SAGEBRUSH_PREVIEW_MOCKS=remote-kernel
```

Only the two documented `KEY=value` build flags are accepted, as arguments or
inherited values. There is no shell evaluation, arbitrary command argument,
endpoint, bucket, output-directory, host or credentials override. A new lane flag
requires an explicit allowlist change here. The script sets
`SAGEBRUSH_PREVIEW_HOST=<name>.sagebrush.cloud` itself. Names match
`^[a-z0-9][a-z0-9-]{0,40}$`.

The manager creates `~/.local/share/sagebrush/preview-secrets.json` later with mode
600, owned by the user, containing exactly these JSON field names:
`accountId`, `accessKeyId`, `secretAccessKey`. Values are the Cloudflare account's
32-hex ID and an R2 S3 API key pair (32-hex access ID, 64-hex secret). Grant this key
object read/write access to **only** `sagebrush-preview`; do not use an account API
or production storage key. It is intentionally absent from the repo and packet.
The publisher opens only that credential path, refuses symlinks/special files,
checks ownership and permissions, and reads it only after the build has finished.
No AWS/Cloudflare CLI profiles, broader account login or environment credential
fallback is used. It never logs the file, request authorization, S3 response
bodies or raw fetch/JSON errors.

Build children inherit only PATH, HOME, locale, TERM, TMPDIR and the validated
preview flags; production/CoCalc/AWS/Cloudflare token variables are not forwarded.
An environment variable name containing a separate `PROD` or `PRODUCTION` component
(even empty), or a recognized environment selector equal to `prod`/`production`,
refuses the operation before build. The origin remote must be the canonical
`sagemathinc/sagebrush` public repository, and private repository paths are refused.
These are operator guardrails, not a sandbox for malicious source code: branch
build scripts run as the user and must be trusted. Never include secrets in a
preview's static files.

The only remote API is R2's S3 endpoint, constructed from the account ID. Requests
are SigV4 signed for region `auto`, bucket `sagebrush-preview`, never redirected,
and never automatically retried. The full previous prefix listing (at most 6,000 objects) is validated
before writes. All PUT/DELETE keys are revalidated under `<name>/`, including keys
returned by R2: dot segments, backslashes and control characters cannot normalize
an operation into another preview. Assets and CSP sidecars upload before HTML;
stale objects are deleted only after every PUT succeeds. Nothing outside the
exact name plus slash prefix is listed for deletion. The final line is the URL.

Remote work uses one pool of at most eight requests in flight. Assets and policies
finish before HTML starts; every upload/skip finishes before stale deletion.
The first error stops new work, drains the at-most-eight in-flight operations,
and fails without printing a URL. The same 20-minute abort covers every phase.
An admitted item checks for pool failure again after HEAD and before PUT, so
draining after the first failure needs at most the already-running requests'
30-second bound, rather than a new HEAD-plus-PUT chain.
For an existing key, a HEAD compares the current object's signed
`preview-sha256` metadata, content length and content type with the prepared body.
Only exact matches skip PUT. PUT writes that digest as signed R2 metadata. Legacy
objects without metadata are uploaded once. No extra manifest object is needed,
and an interrupted publish cannot cause a last-success manifest to skip a key
that was partially replaced. Lifecycle-deleted objects are uploaded again after
HEAD 404. One publisher per name remains required; HEAD/PUT is not a transaction.

Publication is **not atomic**: users may see a temporary failed page while a name
is being replaced. All final upload bodies (injected HTML, policies, config and SW
included) are frozen in memory and SHA-256 recorded before remote work. Uploads
use those exact buffers without rereading source paths. Final limits are 3,000
objects, 200 MiB total, 16 MiB per non-HTML object and 8 MiB per HTML object; admission counts actual body lengths.
The remote phase has one 20-minute abort deadline shared by listing, all uploads
and deletions, in addition to each request's 30-second limit. Deadline failure
prints a loud partial-publication error and does not print a success URL.

A successful generation contains at most 3,000 objects. One interrupted successor
can leave at most 3,000 + 3,000 = 6,000 objects. The next successful publish admits
that entire previous listing, can briefly reach 6,000 + 3,000 = 9,000 objects
(below the former 50,000 listing ceiling), and deletes stale objects back to at
most 3,000. Thus one interrupted publish can be repaired by the next successful
publish without owner cleanup. There is no stale deletion on a failed upload.
Repeated interrupted recoveries can exceed the 6,000 admission and then require
owner inspection/cleanup or lifecycle expiry; no unconditional recovery from an
arbitrary sequence of failed runs is promised.

A per-name lock directory in the Git common directory serializes that name across
local worktrees, and `preview-build.lock` in this checkout's absolute Git directory
also serializes different-name publishers using the same worktree. Both are held
through preparation and publication; neither is a cross-machine lock. Use one
publisher per name across machines. SIGTERM, SIGINT and SIGKILL may leave either
lock stale. Inspect the old publisher and its descendants before removing its
`preview-<name>.lock` and/or `preview-build.lock` directory; never blindly break a
live lock. A normal completion or thrown failure removes the locks it acquired.

## Runtime behavior

The Worker validates the hostname and each path component before R2 access. It
serves exact files and directory `index.html` files; missing APIs do not become an
SPA fallback. Only GET and HEAD are admitted. Dotfiles, `.preview` policy sidecars,
`_headers` and `_redirects` are not public routes. There is no authentication; every
served file is public.

On the normal static notebook, two optional discovery requests return expected
404s: `/api/share/me` means sharing is unavailable, and `/pkgset/latest.json`
means no optional package set is installed. Browsers may log these two misses in
the console. They do not prevent the engine starting or local code execution.
Previews do not fabricate account/auth responses or proxy production services.

All responses get COOP `same-origin`, COEP `require-corp`, CORP `cross-origin`,
`nosniff`, `no-referrer`, `X-Robots-Tag: noindex, nofollow, noarchive`, and no-store /
no-transform. CORS `*` supports the opaque-origin interpreter's fetches. Content
types are selected from a fixed extension table. It never forwards R2 metadata or
sets cookies. It does not use an edge cache. HTML gets the actual build-generated
CSP from a private sidecar; missing/malformed/oversized policies fail closed. Page
connections are narrowed to self/data/blob; runner `connect-src 'none'` and the
shell worker's stricter policy stay intact. JS workers retain the eval/WebAssembly
capability needed by the interpreter. External auth, sync and remote backends must
be replaced by lane mocks; the preview Worker has no proxy endpoints.

The publisher inserts a visible `PREVIEW, not production` banner and an external
same-origin config script into user-facing HTML. Existing inline scripts are
unchanged, so their CSP hashes remain valid. `engine/`, `runner/` and `frame/` HTML
is preserved byte-for-byte: adding a banner there would break engine manifests,
runner sizing or exported frames. The containing preview page carries the banner.
Those directories are for machine/embedded pages, not independent preview UIs.

The regular app service worker's digest table describes the unmodified production
shell. Previews therefore replace `sw.js` with a small worker that unregisters
itself and has no fetch handler. They do not cache an old branch shell or pretend
the modified HTML still matches its old digest. Preview offline/PWA behavior is
not representative of production. A browser previously running a foreign service
worker on the same preview name may need its old worker unregistered and a reload.

## One mock-switch convention

A lane imports `mockEnabled` from `web/preview/mock.js` and supplies its own fake:

```js
import { mockEnabled } from '../preview/mock.js';
const kernel = mockEnabled('remote-kernel') ? makeFakeKernel() : makeRealKernel();
```

The pipeline injects build defaults from `SAGEBRUSH_PREVIEW_MOCKS`. For a particular
page, `?mock=remote-kernel,agent-feed` replaces the defaults, and `?mock=` disables
all defaults. The switch only turns on at a validated `*.sagebrush.cloud` hostname;
query parameters cannot enable mocks on sagebrush.space, dev or arbitrary hosts.
Unknown names passed to the helper throw. Query entries with unknown names do not
activate anything. This switch conveys no permission and supplies no fake itself.

| Name | Lane-supplied implementation |
| --- | --- |
| `remote-kernel` | `web/notebook/remote-fake.js`, behind the normal kernel interface |
| `agent-feed` | Fake turn-event feed behind the agents panel feed interface |
| `sync-ref` | In-process reference sync server |
| `journal-active` | `journalActive()` returns true |
| `sagetex` | Fake SageTeX executor (A6 waits for S1) |

Query parameters must be carried into a lane's navigation if that lane wants a
query-only override to persist; build defaults are supplied to every user-facing
page. Worker/iframe mocks should be selected by their parent and passed through
the lane's existing interface; the shared switch does not invent a new protocol.

## Resource bounds and validation

| Operation | Bound and refusal behavior |
| --- | --- |
| Worker storage operations | At most two file probes plus one policy read; assets stream without buffering |
| HTML policy body | 32 KiB; otherwise 503 |
| Final upload manifest | 3,000 objects including every sidecar/synthetic body, 200 MiB total, 16 MiB/non-HTML and 8 MiB/HTML; buffers held in memory, each hashed once in preparation |
| Source read/tree | One no-follow bounded read per source, at most 16 MiB (HTML 8 MiB), depth 32; concurrent growth refused |
| Build headers | Regular file, 64 KiB, 200 rules including non-CSP slash records; exactly one CSP match per HTML/shell bootstrap; at most 600,000 rule visits |
| Credential file | Owned regular mode-600 file, 16 KiB; fixed schema |
| Previous listing | At most 6,000 objects / 6 pages of 1,000 keys, 8 MiB/page; all keys checked before uploads |
| Remote phase and requests | 20 minutes overall; each S3 request also 30 seconds including body consumption; no retries |
| Upload/deletion | At most 8 requests in flight; at most 3,000 HEADs + 3,000 PUTs + 6,000 DELETEs, plus at most 6 listing GETs; exact frozen manifest buffers, no source rereads or multipart uploads |
| Publisher memory planning envelope | 1 GiB/process: 200 MiB manifest + 128 MiB active transport input (8 x 16 MiB) + 256 MiB allowance for transport copies/buffers + 128 MiB listing/decoded-key transients + 312 MiB Node/TLS/preparation overhead. HTML transport input is at most 64 MiB. This is a conservative operational budget, not an enforced RSS limit or a claim about fetch's implementation; platform/runtime overhead is not proved by a mocked test. |

The build commands use their normal lifecycle; this script is not a process-tree
supervisor and sets no ad hoc kill deadline for build subprocesses. Use the
approved build runner/CI ownership mechanism for cancellation. No finite
wall-clock completion promise is made for a stalled build or filesystem.

The present `test/limit_sites.py` census covers lib, engine, src and two named web
files; it does not scan these scripts/web files. No baseline or registry entry was
changed. The explicit bounds above are in the review scope for daybreak2.

Static checks performed: `node --check` on every JS/MJS file,
`bash -n scripts/preview.sh`, and `git diff --check`. Under Ruling 6, the local
runtime suite was also run through the project wrapper:

```sh
/home/user/sagebrush-coord/bin/ptest -m 3 -- node --test web/preview/test-preview.mjs
```

The latest pre-freeze run passed all 22 tests with 0 failures, including the upload pool, hash skipping, a peer failing while another request is in HEAD, the 8 x 16 MiB active-input control, deployment-entry export shape and separate HTML/non-HTML byte boundaries. Exact output is included in the review packet.
This is information to catch bugs, not CI/VM merge evidence. The suite covers
routing, headers, fail-closed CSP, preserved engine bytes, banner/SW handling,
mock gating, prefix/empty-key safety, frozen bodies and hashes, final count/size
boundaries, header rule/byte boundaries, previous-list admission and remote abort.
Network requests are mocked. No build, real R2 request, credential read, VM proof
or deployment has been performed. A signed R2 smoke publish and real-browser
cross-origin-isolation/LaTeX check remain rollout checks.
