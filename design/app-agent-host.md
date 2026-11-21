# The desktop app as the agent host

*Status: r1, a design note; nothing is built. Author: @sagebrush-macapp. Lanes: SEC (launching agents from the app, and the agent's file access), COPY. Steps that need William (store accounts, signing identities) stay his.*

The direction, Nov 21, 2026, about 11:28 AM PST (verbatim): "for windows I think the sagebrush instructions should not require using a terminal, if possible. I think windows users in particular would be most comfortable getting a signed official sagebrush app from the windows app store, then install it. It would: provide of course our native tauri app; ALSO provide a way to launch claude (etc) sessions. The same argument should also apply to MacOS and maybe even linux. This doesn't at all mean we don't also offer the cli options. it's just that we should have both."

## In plain words

- **One install, no terminal.** The person installs the signed Sagebrush app and presses **Connect Claude** (or **Connect Codex**) in it. The app starts the agent itself, pairs it with its own page, and opens the agent's own sign-in in the browser. They never type a command or a pairing code.
- **The same agent as the command-line path.** The app bundles the same `sagebrush-agent` release that `npx sagebrush-agent` installs, pinned by hash. It runs on the Node the app already ships. The CLI path stays as it is, and both are supported.
- **Order:** first the agent and the Connect button inside the apps we already sign and ship (macOS, then Linux and Windows). Store packaging comes after that.

## 1. The app as the agent host

**What exists.** The macOS and Linux apps ship a pinned Node 24.21.0 sidecar (`binaries/sagebrush-node`, hash-checked against nodejs.org's SHASUMS256 in `app/engine/bundle.mjs`) to run the engine. The Windows app doesn't ship it yet; it comes with the Windows engine work. `sagebrush-agent` is a Node package (Node 20 or later) that:
- runs Claude through Anthropic's Claude Agent SDK, with the person's own Claude login (`~/.claude`);
- runs Codex through `codex app-server`, with the person's own Codex login;
- uses its own pinned, hash-checked Claude Code and Codex, never the ones on PATH;
- pairs with one page origin, using a one-time code that it prints.

**What the app adds.**
- **Bundling.** The app packs the exact `sagebrush-agent` tarball, its shrinkwrapped dependencies, and its pinned Claude Code, beside the engine as a resource. The release's sha256 is pinned in the app's build, the same rule as the agents site's `RELEASE_SHA256`. A mismatch fails the build. At run time the app checks the bundled files' hashes before starting the agent and refuses to start on a mismatch.
- **The Connect button.** It goes in the app's agents page; it needs that page to ship in the app (the app shows a short "not in the app" page for /agents/ today). The app starts the agent on its Node sidecar as a child process, with:
  - `--origin` set to the app page's exact origin, `http://127.0.0.1:<the port the app holds>`, and no other origin;
  - a one-time pairing code that the app generates and hands to both the agent (on its stdin) and its own page (over a Tauri command). Nothing is typed or shown;
  - the agent's working folder set to the app's workspace on disk, or to a folder the person picks.

  The agent ends when the app quits.
- **Sign-in.** It is the agent's own: Claude's and Codex's login flows open the browser. The app never sees a password or a token; the logins live where the CLIs keep them, in `~/.claude` and `~/.codex`. *To verify before building:* how Claude Code's and Codex's logins can be started without a terminal. Both open a browser URL today, but the CLI front ends expect a TTY. The app may need to run them in a hidden pseudo-terminal and open the URL, or use the SDK's own login entry if it has one.
- **The version shown.** The app's About box and the agents page show the bundled `sagebrush-agent`, Claude Code and Codex versions.
- **Updates.** A new agent release reaches app users in the next app release, through the app's normal update. There are no separate downloads at run time in the Store builds (§2). The direct-download builds may keep the agent's own first-use fetch of the pinned Codex, which is hash-checked as in the CLI.

**What the agent may touch.** Exactly what it may touch from the CLI today: the page's grant decides, and "shell and files" on the person's own computer is the switch the agents page already has.
- **Pair:** the agent works on the files where the person points it.
- **Delegate:** the agent works in its own git copy and proposes changes back.
- The agent is not inside the notebook sandbox (srt). It runs as the person, like Claude Code in their terminal. The app only starts it.
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
- **What the Store needs from William:**
  - a Partner Center developer account for SageMath, Inc. Registration is now free for companies as well as individuals (Microsoft, [May 2026](https://blogs.windows.com/windowsdeveloper/2026/05/07/publish-to-microsoft-store-as-a-company-now-with-free-registration-and-faster-onboarding/)); older pages still say $99, so confirm at signup;
  - the company's identity verification;
  - the app's Store listing: its name, privacy-policy link (cocalc.ai/policies/privacy) and age rating.
- The Azure signing profile and the CI signing identity also stay his steps.

**macOS.**
- The notarized Developer ID DMG works today and needs nothing new from Apple.
- The Mac App Store requires the App Sandbox. A sandboxed app's children inherit its sandbox, and the sandbox can't be widened to run other executables; Apple staff also treat code downloaded at run time as conflicting with review guideline 2.5.2 ([Apple forums: developer tools from a sandboxed app](https://developer.apple.com/forums/thread/746478), [QA1773](https://developer.apple.com/library/content/qa/qa1773/_index.html)).
  - An agent that works in the person's folders, keeps its login in `~/.claude`, runs a shell, and (for Codex) fetches its pinned binary fits none of that.
  - **So: no Mac App Store for the agent-hosting app.** A Mac App Store build without the agent would be a different, lesser product.

**Linux.**
- AppImage, deb and rpm stay as they are, signed as now.
- Flathub would add discovery, but its sandbox has the same tension as the Mac App Store, so it would need broad filesystem and host-command permissions. Later and optional.

## 3. What still needs a terminal

**Ideally nothing.** Install, Connect, sign in, work and update all happen in the app and the browser. The CLI path (`npx sagebrush-agent`, `sagebrush remote`) stays for people who want it, and for remote machines without a screen.

Open items that could still need one, to settle while building:
- starting Claude Code's and Codex's logins with no TTY (§1);
- Codex on Windows: `codex app-server`'s support there.

## 4. Order of work, smallest first

1. **Ship the agents page in the app** (it is "not in the app" today), served by the app's own server. SEC: what the page may do in the app.
2. **Bundle `sagebrush-agent` in the macOS and Linux apps** (Node is already there), hash-pinned in the build, with the version in About.
3. **The Connect Claude button:** the app starts the agent with the app's exact origin and an automatic pairing code; the agent's own sign-in. A self-test launches the bundled agent, pairs it, and checks that a second origin is refused.
4. **Connect Codex,** the same way.
5. **Windows:** the Node sidecar (with the Windows engine work), the agent bundled, and the Connect buttons; the NSIS/MSI signed with Azure Artifact Signing (William's profile and identity first).
6. **The Microsoft Store listing** of the signed installer: William's Partner Center account, then the listing.
7. **Optional, later:** MSIX; Flathub.

Steps 1–4 are mine; step 5 follows the Windows engine; steps 6–7 wait on William's accounts.

## Questions for SEC

- **Which origins may the agent take:** only the app page's exact origin when the app starts it, with no `sagebrush.space` alongside it?
- **Where the pairing code lives:** passing it over the child's stdin and a Tauri command, never a file or an argument (arguments are visible to other processes), is enough?
- **The working folder:** default to the app's workspace on disk, or ask every time?
- **Run-time checks:** the bundled tarball's hash is checked before each start, and a failed check refuses to start, with no fallback to a network copy?
