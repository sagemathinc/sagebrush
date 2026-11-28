# Connecting Claude Code and Codex in the desktop app (r3)

*Status: r3, a design note; nothing is built. r3 answers SEC's r2 hold: the pins' schema is exact and closed, the macOS Team ID travels in it, the download is published without replacement, and every helper command is bounded and isolated. r2 took in the agent side's review: no self-update, a closed schema for the pins, Codex's two modes kept apart, the mode set before the rename, and both halves' tests. Owner: the app lane (choosing and downloading in the app). The agent's side (`--claude-path`) is the agent's CLI-mode lane. Lanes: SEC, TESTS. It follows the decision that the app never bundles Claude Code, Codex or similar tools: an installed copy the person already has is used when it is compatible; otherwise the app downloads one from the vendor.*

## 1. What the person sees

The agents page shows, for Claude Code and for Codex, one of:

- **Ready**: the path and the version in use.
- **Not set up**, with two buttons:
  - **Choose installed…** opens a file picker. The app checks the file (§2) and shows its path and version. Only after the person confirms is it used.
  - **Download from Anthropic** (or **from OpenAI**) says the size, downloads it, checks it (§3) and shows the same confirmation.
- **Needs attention**, with the reason in plain words: *this version isn't supported yet (supported: 2.1.330); download the supported version*, *the file changed since you chose it; choose it again*, or *the file's folder can be changed by other users*.

Nothing happens on its own. The app never searches PATH, never downloads without a click, and never switches to another copy on its own.

The Store builds (the Microsoft Store listing, design/app-agent-host.md §2) make no executable downloads at run time, so they offer only **Choose installed…** and no Download button. The direct-download builds offer both (design/app-agent-host.md §1, Updates).

A copy the person installed may update itself: Claude Code's own installer does by default. After an update it no longer matches what was chosen, so the app shows *the file changed; choose it again*, or *this version isn't supported yet*. That is the rule working. The page says so, and recommends the downloaded copy for a setup that stays put.

## 2. Choose installed (the person's own copy)

The rules are SEC's, as cleared.

1. **The path.** It is absolute, from the file picker. The final link is resolved once, and the resolved target is the one bound and shown. Before every later use the app lstats that target, which must not be a link, and compares its identity with the one recorded: device, inode, size, mtime and mode. Any difference means *choose it again*, never a silent re-resolve.
2. **The file.**
   - It is a regular file and executable.
   - It is owned by the person or by root, and not writable by group or others.
   - Every folder above it is owned by the person or by root, and not writable by group or others. The one exception is a root-owned sticky folder, but a file under `/tmp`-like folders still fails, because the rule covers the file's own folder too.
3. **The version.**
   - `<path> --version` runs with no shell, a fixed minimal environment (no inherited keys), a neutral working folder and stdin closed.
   - It has a 5 s deadline, with the process group killed at the deadline, and stdout and stderr each capped at 4 KiB.
   - The answer must be exactly `<v> (Claude Code)`, with `v` in the agent's supported set. For Codex it must be the exact answer the agent's Codex check already expects.
4. **What's kept.** The app's settings keep the path, the recorded identity, the version and when it was confirmed. They keep no copy of the file and nothing from the person's login.

No signature check is made on a copy the person chose (SEC: their own explicit choice).

## 3. Download from the vendor

### Claude Code

- **Channel:** Anthropic's own release host, the one Anthropic's installer uses: `https://downloads.claude.ai/claude-code-releases/<version>/<platform>/claude`. Platforms are `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, the `-musl` variants, and `win32-x64` / `win32-arm64` (`claude.exe`).
- **What's pinned:**
  - For each supported version and platform: its URL, SHA-256 and size.
  - The values come from that version's `manifest.json` on the same host. That manifest lists every platform binary's SHA-256 and size. Anthropic signs it with its Claude Code release signing key, published at `https://downloads.claude.ai/keys/claude-code.asc`, fingerprint `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`.
  - The maintainer's script checks the detached signature (`manifest.json.sig`) against that key and fingerprint before it writes the pin.
  - At run time the app trusts only the pin, never a manifest it fetches.
- **Where the pin lives:** in the agent's `lib/claude-pin.json`, which already names the supported version, extended with the per-platform `{url, sha256, size}`.
  - The agent is inside the app's verified bundle, so the pin is app-controlled. It also sits next to the version set it must agree with.
  - The app reads it through `sagebrush-agent --claude-versions`, extended to print the pins, after `verify_bundle` has passed. Its output has an exact, closed schema: `{"claude": [{"version", "macos_team_id", "platforms": {"<platform>": {"url", "sha256", "size"}}}]}`.
    - **Top level:** exactly the key `claude`, an array of 1 to 8 entries, at most 64 KiB of output in all.
    - **Each entry:** exactly the keys `version`, `macos_team_id` and `platforms`.
      - `version` is canonical `MAJOR.MINOR.PATCH`: decimal with no leading zeros, each part at most 6 digits. Versions are unique.
      - `macos_team_id` is Anthropic's Team ID: exactly ten characters, each an uppercase letter or a digit.
      - `platforms` has exactly the eight keys of the supported set, `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`, `win32-x64` and `win32-arm64`: no alias, none missing, none extra.
    - **Each platform:** exactly the keys `url`, `sha256` and `size`.
      - `url` must EQUAL the canonical URL the app builds itself: `https://downloads.claude.ai/claude-code-releases/` + version + `/` + platform + `/claude`, or `/claude.exe` for the two `win32` keys. It is compared as a string, never parsed or normalized first.
      - `sha256` is 64 lowercase hex characters.
      - `size` is an integer from 1 to 1 GiB.
    - JSON with a duplicate key anywhere is refused.
    The app refuses anything else, even from its own verified bundle. The agent's test and the app's test read the same schema, from one fixture, as with the reason list.
- **The download** (Rust, in the app):
  - **Host and size:** HTTPS only, to that host only, with at most 3 redirects, each to the same host. The size cap is the pinned size exactly: a byte more stops it.
  - **Deadlines:** 10 min in all, and 60 s without bytes.
  - **Where it goes:** a new file in the app's per-user folder, `<app data>/tools/claude/<version>/`. Every folder on the way is made 0700, owned by the person, and refused if it is a link or already exists in another form.
  - **Writing it:**
    - A temporary file is created in the verified destination folder itself, under a fresh name with 128 random bits (`.claude.<random>.part`), opened with `O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0600, and hashed as it is written.
    - Size and SHA-256 are compared with the pin. On macOS the code signature is then checked against the pin's Team ID (below).
    - The open file is set to 0755 (owner-writable only) and fsynced.
  - **Publishing it without replacement:**
    - The file is published with a hard link from the temporary name to the final name. A hard link is atomic and fails if the final name exists, on Linux, macOS and Windows alike, so a destination that appeared at any moment before publication makes it fail. The Rust standard library does this safely (`std::fs::hard_link`), with no `unsafe`.
    - The temporary name is then unlinked and the folder fsynced.
    - If the final name exists, nothing is replaced. The attempt fails with *a file is already there*, and the person can choose it (§2) or remove it.
  - **Cleaning up:** an attempt removes only its own temporary file, by the name it created, after lstat confirms the same device and inode it opened. It never removes anything by pattern.
  - **Then:** it gets exactly the checks of §2, the version included, before the confirmation.
  - **Never:** run from Downloads, a temp folder or a folder others can write.
- **Platform signatures, as a second line:**
  - On macOS, Anthropic signs the binary with its Developer ID ("Anthropic PBC") and Apple notarizes it. The app checks it before publication with the same code as the app's own Node check:
    - strict validation, in every architecture;
    - the requirement `anchor apple generic` plus a Developer ID Application leaf whose OU is the pin's `macos_team_id`.
    The Team ID comes only from the pin, never from the downloaded binary. If this check fails while the SHA-256 matches, the download is refused and the page says why; there is no fallback.
  - On Windows the binary is Authenticode-signed by "Anthropic, PBC".
  - Linux binaries aren't individually signed.
  - Everywhere, the pinned SHA-256 is the authority.

### Codex

The agent already has this. `lib/codex-pin.json` pins, per platform, the npm platform tarball of `@openai/codex`: the same bytes as OpenAI's GitHub release and Homebrew cask, its size, its SHA-256 and every file in it. `lib/codex-fetch.mjs` downloads it on first use into a private 0700 cache and checks every file at every start. The app reuses it rather than adding a second downloader:
- **Download from OpenAI** runs the agent's fetch as an explicit command (a new `sagebrush-agent --fetch-codex`, with progress on stdout), only on that click.
- **Choose installed** for Codex follows §2 and is passed as `--codex-path`, mirroring `--claude-path`.
- **The two modes don't mix.**
  - With `--codex-path`, the agent never touches its fetch cache.
  - Without it, the agent uses only the cache that `--fetch-codex` filled, rechecked at every start as today.
  - Neither ever falls back to the other.
  - `--fetch-codex` fails with a non-zero exit and one reason word, in the same style, when a file doesn't match.

## 4. Handing it to the agent

The host passes one absolute path: `--claude-path <path>` (with `--pair-stdin`), and later `--codex-path`. The agent repeats §2's checks on its own and refuses with exit 3 and one reason word:
- `not_absolute`, `missing`, `not_regular`, `not_executable`;
- `writable_by_others`, `parent_writable`;
- `version_unknown`, `version_mismatch`, `no_answer`;
- `identity_changed`, `unsupported_platform`.

The list is a closed constant in the agent; the app mirrors it, with a test that reads the agent's list. A turn whose binary changed ends with `identity_changed`, and the app shows *choose it again*.

**Every helper process is bounded and isolated** in the same way:
- the person's Claude Code and Codex, for `--version` and Codex's version check (the probes);
- the bundled agent's control commands: `--claude-versions` and `--fetch-codex`.

Each runs with no shell, an explicit minimal environment (below), a fixed working folder (the app's private `tools/` folder), stdin closed, and stdout and stderr each capped.

The agent's sessions are different. Claude Code runs with `--input-format stream-json`, and `codex app-server` speaks JSON-RPC, each over the agent's own pipe to its stdin and stdout. Those keep that pipe open, owned by the agent. They get the same no shell, minimal environment, own process group and kill when the app quits. Their output goes to the agent's protocol reader, not under the probes' caps. `--claude-versions` is capped at 64 KiB; the version checks at 4 KiB; `--fetch-codex` reports progress lines of at most 256 bytes and 64 KiB in all. Each has a deadline: 5 s for version checks and `--claude-versions`, 10 min for `--fetch-codex`. It is started in its own process group, killed as a group at the deadline or when the app quits, and reaped.

`--fetch-codex` is given its cache root explicitly, as `--codex-cache <the app's private folder>/codex`, a 0700 folder the app made and checked.

The rules below are for the app's mode, the agent run with `--pair-stdin`. In that mode, starting Codex without `--codex-path` uses only a complete, rechecked cache under that root. If there is none, the start fails with a reason word and makes no network request: the only download is the one `--fetch-codex` makes after the person's click.

Without `--pair-stdin`, the agent run on its own (the command line, a remote runner) is unchanged: it still fetches its pinned Codex on first use, as today. `--claude-path`, `--codex-path` and `--codex-cache` are refused outside `--pair-stdin`.

The minimal environment:
- no inherited keys;
- for Claude Code, `DISABLE_AUTOUPDATER=1`, so a pinned or chosen binary never updates itself or writes elsewhere;
- for Codex, the same: its update check turned off the way the pinned version reads it (recorded beside the pin);
- the person's own Claude home, where its login lives (the agent's existing rule: nothing reads, copies or changes it);
- for Codex, the person's own Codex home, by the same rule.

## 5. Versions

The supported set is the versions the agent has tested: its CLI test rows run against the real binary. It starts as the pin, `2.1.330`. An installed copy outside the set is refused, and the app offers the download of a supported one. Moving the set forward is an agent release, then a pin bump in the app's bundle.

## 6. Windows

Not yet: the app's agent host doesn't start agents on Windows, and `--claude-path` there refuses with `unsupported_platform`. When the Windows host comes, the rule will be:
- the owner is the person, SYSTEM or Administrators;
- no write ACE for Everyone, Users or Authenticated Users, on the file or any folder above it.
SEC rules on it then.

## 7. Tests

- **The app's packaging:** the built app's agent manifest names none of the SDK's platform packages and no `claude` or `claude.exe` file; a control build that keeps one fails.
- **The app:** each §2 refusal on a real file:
  - a link given, with its target bound;
  - the target swapped after the choice;
  - group- or world-writable;
  - a folder above that others can write, and the root sticky case;
  - another owner;
  - version answers: exact, with a trailing space, newline or extra line, a hang past 5 s with its group killed, more than 4 KiB.
- **The download, against a local HTTPS stand-in:**
  - a byte changed, one byte too many, a short file;
  - a redirect to another host;
  - an existing destination, a link at the destination, a folder above that isn't 0700;
  - an interrupted download leaving nothing in place.
- **The agent** (its CLI-mode lane's rows):
  - `identity_changed` before a spawn, with no spawn;
  - no bundled or PATH fallback when `--claude-path` fails;
  - the version answer's variants, a hang past 5 s with its group killed, more than 4 KiB;
  - a link given, with the target bound;
  - each ancestor case, and another owner;
  - `DISABLE_AUTOUPDATER=1` in the spawn's environment, and nothing inherited;
  - for Codex, likewise: its update check off in the spawn's environment or configuration, set the way the pinned version reads it (recorded beside the pin), so a pinned or chosen Codex never updates itself or writes a copy elsewhere;
  - a first successful turn through each session transport: Claude Code over stream-json on the open stdin, and `codex app-server` over JSON-RPC;
  - `--claude-versions` against the schema, and Codex's two modes never mixing.
- **SEC's r2 rows** (permanent, both halves where they apply):
  - a URL with a suffix that normalizes, such as `/claude/../claude`, `%2e`, a trailing `/` or `?x`, refused;
  - duplicate, missing and extra versions; duplicate, missing, extra and alias platform keys; a duplicate JSON key; over-long output; too many entries;
  - the Team ID absent, malformed (lowercase, nine or eleven characters) or wrong;
  - the destination created just before publication: the hard link fails and nothing is replaced (rolled back, temporary file gone);
  - the temporary file cleaned only by its own inode: another file put at that name is left alone;
  - each helper command (`--claude-versions`, `--fetch-codex`, Codex's version check) run with a planted inherited variable, which it doesn't see, past its deadline and over its output cap;
  - Codex started with no cache and the network blocked: it fails with its reason word and attempts no connection.
  - Scope, one row each way: with `--pair-stdin`, no implicit fetch; without it, the first-use fetch is unchanged; `--claude-path` outside `--pair-stdin` is refused.
- **The pins:** the script's output for each pinned version matches the vendor's manifest, and its signature check is tested on a good and a tampered manifest.
- **Mutants per commit**, as usual.

## 8. Order of work

1. The agent: `--claude-path` and the reason list; `--claude-versions` with the pins.
2. The app: Choose installed (§2), its settings, and the hand-off.
3. The app: Download from Anthropic (§3), and the Codex fetch command.
4. Windows, with its host.
