# The desktop app as the agent host

*Status: r2, a design note; nothing is built. r2 answers r1's COPY review (the CLI's real form, what exists versus what is proposed, Apple's rules as cited) and its SEC review (§5, the security requirements). Owner: the app lane. Lanes: SEC (launching agents from the app, and the agent's file access), COPY. Steps that need SageMath, Inc., the account holder (store accounts, signing identities), stay the company's.*

The direction, Nov 21, 2026, about 11:28 AM PST (verbatim): "for windows I think the sagebrush instructions should not require using a terminal, if possible. I think windows users in particular would be most comfortable getting a signed official sagebrush app from the windows app store, then install it. It would: provide of course our native tauri app; ALSO provide a way to launch claude (etc) sessions. The same argument should also apply to MacOS and maybe even linux. This doesn't at all mean we don't also offer the cli options. it's just that we should have both."

## In plain words

- **The goal: one install, no terminal.** It holds once the open items in §3 are settled. The person installs the signed Sagebrush app and presses **Connect Claude** (or **Connect Codex**) in it. The app starts the agent itself, pairs it with its own page, and opens the agent's own sign-in in the browser. They never type a command or a pairing code.
- **The same agent as the command-line path.** The app bundles the same reviewed `sagebrush-agent` release tarball that the CLI path runs (`npx -y <the reviewed tarball's URL>`; the release is a tarball download, not an npm registry package), pinned by hash. It runs on the Node the app already ships. The CLI path stays as it is, and both are supported.
- **Order:** first the agent and the Connect button inside the apps we already sign and ship (macOS, then Linux and Windows). Store packaging comes after that.

## Principle: install channels

Nothing in Sagebrush's design may make it hard to install later through the channels people already use: the platform stores, Homebrew, winget, Flathub, pip and npm. Every artifact stays packageable by them:
- **relocatable:** no absolute paths fixed at build time;
- **no network fetches after install,** except pinned, hash-checked ones that are declared;
- **versions that a machine can read.**

## 1. The app as the agent host

**What exists.** The macOS and Linux apps ship a pinned Node 24.21.0 sidecar (`binaries/sagebrush-node`, hash-checked against nodejs.org's SHASUMS256 in `app/engine/bundle.mjs`) to run the engine. The Windows app doesn't ship it yet; it comes with the Windows engine work. `sagebrush-agent` is a Node package (Node 20 or later) that:
- runs Claude through Anthropic's Claude Agent SDK, with the person's own Claude login (`~/.claude`);
- runs Codex through `codex app-server`, with the person's own Codex login;
- uses its own pinned, hash-checked Claude Code (an exact dependency) and Codex (fetched from upstream on first use), never the ones on PATH;
- pairs with one page origin, using a one-time code that it generates and puts in a pairing link it prints, which the person opens.

**What the app adds.** Everything in this list is proposed; none of it exists yet.
- **Bundling.** The app packs the exact `sagebrush-agent` tarball, its shrinkwrapped dependencies, its pinned Claude Code and, for Connect Codex, its pinned Codex binary for that platform, beside the engine as a resource. Bundling Codex is what lets Connect Codex work with no download at run time. The release's sha256 is pinned in the app's build, the same rule as the agents site's `RELEASE_SHA256`, and a mismatch fails the build. The build also writes a manifest of every file the agent will load. At run time the app checks the files actually loaded against it before starting the agent (§5). If a Store build can't bundle Codex for a platform, Connect Codex is unavailable in that build; it never falls back to a download.
- **The Connect button.** It goes in the app's agents page; it needs that page to ship in the app (the app shows a short "not in the app" page for /agents/ today). The app starts the agent on its Node sidecar as a child process, with:
  - `--origin` set to the app page's exact origin, `http://127.0.0.1:<the port the app holds>`, and no other origin;
  - a one-time pairing code that the app generates and hands to both the agent (on its stdin) and its own page (over a Tauri command). Nothing is typed or shown. This needs new agent support: today the agent generates the code and prints a pairing link for the person to open;
  - the agent's working folder: the selected workspace on disk, shown to the person; when there is none, the app asks for a folder and never falls back to the home folder.

  The app stops the agent, and the work it started, when the app quits (§5).
- **Sign-in.** It is the agent's own: Claude's and Codex's login flows open the browser. The app never sees a password or a token; the logins live where the CLIs keep them, in `~/.claude` and `~/.codex`. *To verify before building:* how Claude Code's and Codex's logins can be started without a terminal. Both open a browser URL today, but the CLI front ends expect a TTY. The app may need to run them in a hidden pseudo-terminal and open the URL, or use the SDK's own login entry if it has one.
- **The version shown.** The app's About box and the agents page show the bundled `sagebrush-agent`, Claude Code and Codex versions.
- **Updates.** A new agent release reaches app users in the next app release, through the app's normal update. There are no executable downloads at run time in the Store builds (§2). The direct-download builds may keep the agent's own first-use fetch of the pinned Codex, which is hash-checked as in the CLI.

**What the agent may touch.**
- **Today, with the CLI:** a local `sagebrush-agent` paired with a page reaches only the workspace tools that page's grant allows (writing a notebook, its own git branch, and so on); it has no shell or files on the computer. Shell and files on a computer come only through `sagebrush remote` and that computer's explicit grant ("Allow shell and files on <computer>").
- **Proposed for the app, subject to SEC:** the same as today. The app-hosted agent gets the page's workspace tools under the page's grant, and no shell or host files, unless SEC approves a separate, explicit grant for this computer, shown and switchable like the remote one. Pair and Delegate behave as on the web: Pair works on the workspace files the person points it at; Delegate works in its own git copy and proposes changes back.
- The agent process itself is not inside the notebook sandbox (srt): it runs as the person, as the CLI agent does. The app only starts it.
- The app's own commands (the workspace on disk, settings, quit) still answer only the page's exact origin; the agent talks to the page, not to the app's commands.

## 2. Distribution per OS

| OS | Now | Store option | Recommendation |
|---|---|---|---|
| Windows | NSIS setup and MSI, unsigned | Microsoft Store | Sign the NSIS/MSI with Azure Artifact Signing (account `sagejs-signing`, the identity already validated), then list that signed installer in the Store as a Win32 app. Consider MSIX later. |
| macOS | DMG, Developer ID signed and notarized | Mac App Store | Stay with the notarized DMG. The Mac App Store's sandbox conflicts with an agent host. |
| Linux | AppImage, deb, rpm | Flathub | Keep AppImage/deb/rpm. Flathub is optional, later. |

**Windows.**
- The Store accepts plain Win32 MSI and EXE installers. The installer must be Authenticode-signed by us with a certificate from a trusted CA; the Store doesn't re-sign it, so it needs the Azure signing first. It must be hosted at a stable URL, with the binary at that URL unchanged after submission. ([Microsoft: get started with the Store](https://learn.microsoft.com/en-us/windows/apps/publish/faq/get-started-with-the-microsoft-store))
- MSIX packaging is the alternative: the Store signs MSIX itself. A full-trust MSIX app may start child processes. But MSIX virtualizes some file and registry writes, which matters for an agent writing `~/.claude` and working in user folders. So the signed MSI/NSIS listing is the smaller step.
- **What the Store needs from SageMath, Inc.:**
  - a Partner Center developer account for SageMath, Inc. Registration is now free for companies as well as individuals (Microsoft, [May 2026](https://blogs.windows.com/windowsdeveloper/2026/05/07/publish-to-microsoft-store-as-a-company-now-with-free-registration-and-faster-onboarding/)); older pages still say $99, so confirm at signup;
  - the company's identity verification;
  - the app's Store listing: its name, privacy-policy link (cocalc.ai/policies/privacy) and age rating.
- The Azure signing profile and the CI signing identity also stay the company's steps.

**macOS.**
- The notarized Developer ID DMG works today and needs nothing new from Apple. A Homebrew cask for it, in our own tap, comes later (§4).
- The Mac App Store requires the App Sandbox. A sandboxed app's child processes inherit its sandbox, and no dynamic sandbox extension grants executable access outside its static sandbox ([Apple forums](https://developer.apple.com/forums/thread/746478)). Review guideline 2.5.2 also says apps may not download, install or execute code that changes their features, with a limited exception for educational apps that teach or let students test code ([App Review Guidelines, 2.5.2](https://developer.apple.com/app-store/review/guidelines/#software-requirements)).
  - An agent host fits these badly. Claude Code keeps its login in `~/.claude`, outside the app's container. A Pair or Delegate agent works in the person's folders. Codex is a separate binary from upstream.
  - **This design's recommendation: no Mac App Store for the agent-hosting app.** That is our reading of the rules for this design, not an Apple ruling on an app that hasn't been submitted. A Mac App Store build without the agent would be a different, lesser product.

**Linux.**
- AppImage, deb and rpm stay as they are, signed as now.
- Flathub would add discovery, but its sandbox has the same tension as the Mac App Store, so it would need broad filesystem and host-command permissions. Later and optional.

## 3. What still needs a terminal

**The goal is nothing:** install, Connect, sign in, work and update all in the app and the browser. It isn't verified until the open items below are settled. The CLI path (the reviewed tarball through `npx -y`, and `sagebrush remote`) stays for people who want it, and for remote machines without a screen.

Open items that could still need one, to settle while building:
- starting Claude Code's and Codex's logins with no TTY (§1);
- Codex on Windows: `codex app-server`'s support there.

## 4. Order of work, smallest first

1. **Ship the agents page in the app** (it is "not in the app" today), served by the app's own server. SEC: what the page may do in the app.
2. **Bundle `sagebrush-agent` in the macOS and Linux apps** (Node is already there), hash-pinned in the build, with the version in About.
3. **A Homebrew tap, low priority:** `sagemathinc/homebrew-sagebrush`, with a cask for the notarized DMG that the app release job updates. A formula for the CLI can come later, and homebrew-cask's core repository once the app is popular enough. The tap repository is created when this step is reached, not before.
4. **The Connect Claude button:** the app starts the agent with the app's exact origin and an automatic pairing code; the agent's own sign-in. A self-test launches the bundled agent, pairs it, and checks that a second origin is refused.
5. **Connect Codex,** the same way.
6. **Windows:** the Node sidecar (with the Windows engine work), the agent bundled, and the Connect buttons; the NSIS/MSI signed with Azure Artifact Signing (the company's signing profile and identity first).
7. **The Microsoft Store listing** of the signed installer: SageMath, Inc.'s Partner Center account, then the listing.
8. **Optional, later:** MSIX; Flathub.

Steps 1–5 are the app lane's (step 3 when it is worth doing); step 6 follows the Windows engine; steps 7–8 wait on the company's accounts.

## 5. Security requirements

SEC answered r1's questions; these are requirements for the implementation, not things the agent does today.

- **Origin.** An app-launched agent accepts only the app's own exact origin, `http://127.0.0.1:<the bound port>`. It takes no other port, `localhost` alias, `sagebrush.space`, or null or missing origin. The app keeps its exact-origin capability and its navigation guard, and notebook and example output frames can't reach the launch, pairing or file commands.
- **Launch.** The app alone chooses the executable (an absolute path to its own read-only resources), the fixed arguments, the origin and the working folder. It launches without a shell and without searching PATH. The page can only ask to connect or disconnect; it never supplies a command, an argument, an environment, a code or a process id.
- **Pairing.** The code is unpredictable, fresh for each launch, single-use, and invalid once the start fails, the child exits or a new one replaces it.
  - It travels only over the child's stdin and an exact-origin Tauri command. It never goes in arguments, the environment, a URL, logs or disk, and never back through the app's HTTP server.
  - The page pairs only with the child the app has just launched. A stale page or a replaced child keeps no new code or permission.
- **Grants.** Connect is not a grant. Pairing automatically keeps the page's grant prompt and the Pair and Delegate boundaries, and gives no shell or host files (§1).
- **Working folder.** The default is the selected workspace on disk, shown; with none, the app asks. It isn't asked again on reconnecting to the same folder. The folder is a default, not a sandbox: the agent runs as the person.
- **Integrity.** The build pins the source archive and writes a manifest of the installed files. Extraction refuses paths or links that would escape.
  - At each start the app checks the files actually loaded against the manifest: the agent's modules and dependencies, the Node sidecar, and the bundled Claude Code and Codex executables. Checking the archive alone isn't enough.
  - The app runs its own immutable, versioned resources, never a copy in a workspace or cache.
  - A mismatch refuses to start, with no fallback to the network.
  - This doesn't protect against a hostile program already running as the same person.
- **Shutdown.** Quitting, or reconnecting, stops the agent the app started and the work it started, through the agent's task-cleanup protocol, and invalidates its pairing. The app never signals a process id the page supplies, and doesn't assume that killing the parent stops its children.
- **Login.** Starting the Claude Code and Codex logins stays open (§3). The app doesn't parse or keep credentials, and the output of any hidden terminal used for login never goes into the app's general logs.
- **Tests with the implementation:**
  - a second origin, a null origin and an output frame are refused;
  - an injected launch argument is refused;
  - a stale or replayed pairing code is refused;
  - Connect without a shell-and-files grant gets no shell;
  - a corrupted dependency or vendor binary refuses to start, with the network off;
  - quitting with a task still running stops it.
