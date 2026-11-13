# Connecting a computer in one line

## In plain words

The goal: start any machine (a rented container, a lab server, a laptop), paste one line into its terminal, and then use a Sagebrush terminal, chat, notebook and whiteboard on it, with as little reading and thinking as possible.

Today that takes about ten steps across two documentation pages, two terminal commands, an approval page and a menu that is hidden unless the account is on a list. On the published package, enrolling fails outright on the testing site. Only the terminal works over the connection so far: the notebook's "Run on your computer" reaches only the browser's own machine, so it can't reach a container, and the chat needs Node and an agent login on the machine.

This note does three things:
- it walks through today's flow step by step, from a real timed trial in a fresh container;
- it describes the target;
- it lists the gaps between them, in order, each small enough to be one change.

---

## 1. Today, step by step

**The trial.** A fresh `debian:stable-slim` container (root; no Python, Node, curl, wget or systemd) on a cloud VM (Intel Xeon 2.80 GHz), against the testing site, on Nov 13 2026. The person is assumed to start from the connect page's instructions, which are the only place the relayed commands are written down. The times are the trial's own; the person's reading time is extra.

Marks:
- **[read]** the person has to read and understand something to go on;
- **[think]** the person has to decide or work something out;
- **[silent]** it can fail without saying so, or with words that don't say what to do.

| # | Where | What the person does | What happens | Time | Marks |
|---|---|---|---|---|---|
| 1 | Sagebrush | Finds out that a computer can be connected. Nothing on the notebook page says so; the way in is the Agents page's "Learn more", then the connect page's option 1. | | | [read] [think] |
| 2 | Connect page | Reads option 1: the loopback command first, then "There is also a relayed version … open to test accounts only so far". Picks the relayed one. | | | [read] [think] |
| 3 | Connect page | Notices that it needs uv. The command for uv is on another page (the notebook's pairing sheet, or uv's site). | | | [read] |
| 4 | Container | `curl -LsSf https://astral.sh/uv/install.sh \| sh` | **Exits 0 and installs nothing**: "curl: command not found", and `sh` succeeds on empty input. | 0.1 s | [silent] |
| 5 | Container | Installs curl: `apt-get update && apt-get install -y curl ca-certificates` | | 5.8 s | [think] |
| 6 | Container | Runs the uv installer again. | uv in `~/.local/bin`; on the PATH only in a new login shell, or after `source $HOME/.local/bin/env`. | 0.6 s | [read] |
| 7 | Container | `uvx sagebrush@latest remote login --origin https://dev.sagebrush.space` | The first run downloads CPython 3.15.2 (36.6 MiB) and sagebrush (6.7 MiB): 2.5 s. **Then fails**: "https://dev.sagebrush.space answered the enrollment unexpectedly". The published client (0.10.0) accepts a code that lives at most an hour; the site now gives codes a day. | 2.5 s | [silent] |
| 7′ | Container | (Without `--origin`, as `uvx sagebrush@latest remote` alone suggests.) | "https://sagebrush.space refused the enrollment: not found": the main site doesn't offer it. | 0.5 s | [silent] |
| 8 | Container | (With a client built from the current source, in the trial's place.) | "To let this computer run code for your sagebrush account, open https://dev.sagebrush.space/remote/activate?code=… signed in, and check that it shows the code ….  (Waiting 24 hours.)" | < 1 s | [read] |
| 9 | Browser | Opens the link (types or copies it out of the container's terminal), signs in if needed, checks the code, clicks Approve. | "Approved. *name* is now one of your remotes; the command continues by itself." The name is the machine's host name: in a container, its id (`a8c47c9a0ab1`). | (trial: pending) | [read] [think] |
| 10 | Container | The login command ends: "Enrolled as …". Runs `uvx sagebrush@latest remote`. | "Connected to https://dev.sagebrush.space as …". | (pending) | [read] |
| 11 | Container | Closes the terminal. | (trial pending) The runner is a foreground process: closing the terminal ends it, and nothing restarts it. A container restart loses the key too, since it lives in the container's `~/.config`. | (pending) | [silent] |
| 12 | Sagebrush | ⋯ ▸ "Terminal on your computer…". The item is shown only to an account on the remote list. With one computer it opens at once; with several, a list of names. | A shell on the container. | (pending) | [read] |
| 13 | Notebook | "Run on your computer" | Reaches only a program on the browser's own machine (127.0.0.1). **A container can't be reached this way.** The relayed notebook path exists in the code but isn't offered in the page. | — | [silent] |
| 14 | Agents page | "Chat here" with an agent on the computer | (Checked in code.) The runner must be started with `--serve-agents` and `--agent claude="npx -y <tarball URL> --stdio"` (or `--agent-cmd …`); none of that is in the published package or in any one line. The agent needs Node 20+ on the machine for `npx` (via apt: 50.8 s), and the agent CLI logged in there: `claude` (an interactive login in the terminal: 9.9 s of typing and a browser round trip), or for Codex `codex login` **and exactly Codex 0.159.2** (sagebrush-agent 0.7.0 refuses any other version, so a fresh `npm i -g @openai/codex` is refused). On the page, Codex also needs the "shell and files" switch, and the menus don't show a computer's agents yet (the computer list carries them); the switch and the picker are unmerged. | 50.8 s + 9.9 s | [read] [think] [silent] |
| 15 | Whiteboard | Runs a board's code cells | A board's code cells run through a hidden notebook behind it, in the browser. Nothing offers that notebook another kernel yet, so no board's code runs on a computer. | — | — |

**What the trial shows.**
- It takes at least ten actions before a terminal on the container works. Four of them are about installing tools, and three can fail with no clear next step.
- The one documented route on the testing site fails at step 7 with the published package. Nobody can complete it today without a build from source.
- The machine's work is quick: under 10 s in all, apart from Node. The time goes into reading, and into finding the next instruction.

## 2. The target

1. **Add a computer.** On any Sagebrush page, ⋯ ▸ Computers ▸ "Add a computer" (or a "Run on" picker's "Add a computer…"). A dialog asks for a name (prefilled, say "Computer 2"), and shows one line with a Copy button:

   ```
   curl -fsSL https://sagebrush.space/c/AB12-CD34 | sh
   ```

   plus, under "No curl?", the same line with `wget -qO-`, and a line for a bare Debian or Ubuntu image that installs curl first.
2. **Paste it** into the machine's terminal. The script it fetches:
   - checks the platform, and says plainly what it needs if the platform isn't supported;
   - installs uv if it's missing (into the user's home, no root needed);
   - enrolls the machine. It makes its key, redeems the one-time code from the line, and gets the name chosen in step 1;
   - starts the runner in that terminal, in the foreground: Ctrl+C or closing the terminal ends it, and it says so;
   - prints one line: "Connected as Computer 2. Keep this terminal open; Ctrl+C disconnects." (or one sentence saying what went wrong).

   A persistent mode, the runner as a service that survives the terminal and restarts, comes later (gap 4). The line takes a flag for it, so the same line can start either: foreground by default.
3. **The dialog in the browser** turns into "Computer 2 is connected", with Open terminal, New notebook here, and Chat here (if an agent is set up there).
4. **Later,** Computer 2 is in every "Run on" picker and in ⋯ ▸ Computers, each with one-click Terminal, Notebook and Chat.

The one-time code in the line:
- is made by the signed-in person, so no approval page is needed;
- is used once, and lives a short time;
- is bound to that account and to the chosen name.

Running the same line again on an enrolled machine only starts the runner again. Running it on another machine after use says the code is used, and links to "Add a computer".

## 3. The gaps, in order

Each is meant as one small change. The first unblocks everything else.

1. **A sagebrush release from the current source.** Published 0.10.0 can't enroll on the testing site (step 7). A release, not code.
2. **Enrollment started by the site.** An "add" code made by a signed-in person on the site, redeemed by the machine with its new key: a new route beside the device flow, which stays for `sagebrush remote login`. Single use, short life, bound to the account and the name. Needs a security review of the code in a pasted line: it can end up in shell history and scrollback.
3. **The install script** served at the line's address: platform check, uv install, enrollment, foreground start, one-line result. It runs under `sh`, not bash, and refuses clearly when there's no way to fetch.
4. **Later: the runner as a persistent service.** Deferred; the foreground runner is the default. The design leaves room for it: a flag on the same line, then `sagebrush remote --service` (a systemd user unit where there is systemd, otherwise a wrapper with a log, a pid file and a restart after a crash), with `status` and `stop`. A container's restart needs the line again until then.
5. **Add a computer** in the site's UI: the dialog of target step 1, with the live "is connected" turn (it polls the computer list for the new one).
6. **Computers in the menus.** ⋯ ▸ Computers, listing each with Terminal, Notebook and Chat. The terminal item is no longer hidden behind a separate item, and the computer's agents from the list show as Chat entries.
7. **The notebook over the relay.** The relayed notebook path, offered in the "Run on" picker for each computer. The same kernel serves a board's hidden notebook, so a board's code cells (for example live PyTorch samples on a GPU machine) run on the computer too.
8. **Chat on the computer when it has an agent.** (Agents page side; checked in code unless marked.) In order:
   - **8a. The page names each computer's agents.** The computer list already carries the kinds a runner offers (`agents`). The menus show "Claude on Computer 2" and "Codex on Computer 2", and asking for one names that kind; the runner's answer decides. The computer picker and the "shell and files" switch, both written and reviewed but not merged, land first.
   - **8b. The script finds an agent that's already set up.** It looks for `claude` and `codex` on the PATH, and for Node 20+ (the agent runs with `npx`). It starts the runner with one `--agent` per agent it found. Whether an agent is logged in can't be read without touching its login files, so the script doesn't check that: the first Chat says so if it isn't (8d). (Assumed: no install of Node or of an agent by the script; see §4.)
   - **8c. Codex's exact version.** sagebrush-agent accepts exactly the Codex versions it was reviewed with (0.159.2 today). Either releases follow Codex closely, or the script pins the Codex it installs. A policy decision for the security review, not only a change.
   - **8d. Chat here with no agent, or one not logged in: sign in from the page.** A small panel, in two steps, with no naming step:
     1. **"Open Claude sign-in."** The runner starts the agent's own login on the computer. That is the normal, renewing login, never a long-lived token unless one is needed. The runner relays the sign-in link the login prints, and the page opens it in a new tab.
     2. **"Paste the authentication code."** The person pastes the code their browser shows. The page sends it to that login on the computer, and **it connects as soon as it's pasted**, with no Connect button. On success the chat retries the message.

     The login is the agent's own, and its result is stored on the computer by the agent, never by Sagebrush. Sagebrush only carries the one-time code from the page to the login, over the computer's own connection. It never holds, forwards or copies the resulting credentials. **Open, for a decision:** the security review counts carrying that one-time code as forwarding a credential, short-lived and single-use or not. Typing it into Sagebrush's terminal on that computer crosses the same connection, so it's no workaround. The choice is between:
       - allowing this one transient exception, under the review's conditions (below); or
       - keeping sign-in wholly outside Sagebrush: the person's own terminal on that machine (local, or their own SSH), or a provider flow where the code never enters Sagebrush, as Codex's device-code login (its code is typed on the provider's site, not here).

       The conditions, if the exception is allowed:
       - the person starts it;
       - one fixed login process on the chosen computer, with a login id bound to that connection;
       - the code is accepted once, for that live login only, never queued or replayed after a reconnect, never delivered to another process;
       - a short timeout, and Stop, cancel or revoke ends it;
       - the code never appears in an echo, transcript, chat, log, telemetry, storage, URL or command line, and its length is bounded;
       - the login's own output is filtered so an echoed code or token never travels back;
       - only the tool's own reported status is exposed;
       - the runner never reads or copies the tool's login files.
       Fake-process tests must show each.
     - **Codex:** the device-code login runs the other way: the panel shows "Open sign-in" and the short code to type there, with nothing to paste. Turning device-code sign-in on in the person's ChatGPT security settings is hard to find, so when Codex refuses because it's off, the panel says so plainly, with a direct link to that setting if there is one.
     - **Without the panel:** "Open the terminal" types the same login into that computer's terminal (`claude`; `codex login --device-auth`).
     - An agent that isn't logged in says the same through its first reply (today's words say to run `claude` or `codex login` there; the agent's next release says `codex login --device-auth`).
   - **8e. The runner's side of sign-in.** Three things on the agent's own connection:
     - a login request per agent kind. It starts that tool's own login on the computer, in the person's account, and returns the link it prints (and Codex's code);
     - a way to hand the pasted code to that login, and to that login only. It's never stored or logged;
     - "is it logged in", answered by asking the tool itself (its own status command), never by reading its login files.
9. **The connect page** rewritten around the one line: today's text names an old version and puts the relayed route last.
10. **The main site.** Configuration only: the code is already deployed there, and switched off by its configuration (the relay's objects, the per-address limit, the challenge key and who may connect are bound on the testing site only). One configuration change with its tests, after two decisions: who may connect first, and how the challenge key is kept. Its database changes are already applied. Top priority.

## 4. Decided, and still open

- **A whiteboard on the computer** (decided): a board's hidden notebook uses the computer as its kernel, the same path as a notebook (gap 7).
- **The main site** (decided): as soon as possible, ahead of the rest. Who may connect first, and the challenge key, are being decided (gap 10).
- **Foreground or persistent** (decided): foreground by default, so Ctrl+C ends it. A persistent service is deferred, and the line leaves room for it (gap 4). Containers that restart need the line again for now.
- **How an agent signs in on the machine** (decided). Any of these, all the person's own:
  - (a) whatever login the agent already has there;
  - (b) the agent's own login, typed into the Sagebrush terminal on that machine. Codex: `codex login --device-auth` (a link and a one-time code; it only works once device-code login is turned on in the person's ChatGPT security settings, so say that if it fails). Claude Code: its login shows a link; the person signs in in their browser and pastes the code back;
  - (c) an API key the person sets there themselves, in the shell that starts the runner, which passes its environment on to the agent. It's billed to the API account, not the person's plan;
  - (d) for Claude, only if it's needed, a long-lived token (`claude setup-token` on a machine where they're signed in) that the person sets there as `CLAUDE_CODE_OAUTH_TOKEN`. The normal renewing login is preferred: it's one computer in one place.

  Sagebrush never holds or forwards a credential, and never suggests copying login files between machines. Credentials kept for "hosted agents" are a later job, not Sagebrush's. The connect page documents (c) and (d) with the billing caveat. Chat here's sign-in panel (8d) runs (b) from the page: open the link, paste the code, and it's connected. A later option could add one to the line (say `… | sh -s -- --with claude`), but only after 8a-8d.
