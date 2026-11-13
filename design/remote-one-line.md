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
| 14 | Agents page | "Chat here" with an agent on the computer | Needs the runner started with `--serve-agents --agent-cmd …` (not in the published package), Node on the machine (via apt: 50.8 s), and an agent logged in on the machine (an interactive login in the terminal). | 50.8 s + 9.9 s | [read] [think] |
| 15 | Whiteboard | — | Nothing runs a whiteboard on a computer. Boards are documents in the browser. | — | — |

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
   - starts the runner detached, with a log file, so that it survives the terminal closing;
   - prints one line: "Connected as Computer 2. You can close this terminal." (or one sentence saying what went wrong).
3. **The dialog in the browser** turns into "Computer 2 is connected", with Open terminal, New notebook here, and Chat here (if an agent is set up there).
4. **Later,** Computer 2 is in every "Run on" picker and in ⋯ ▸ Computers, each with one-click Terminal, Notebook and Chat.

The one-time code in the line:
- is made by the signed-in person, so no approval page is needed;
- is used once, and lives a short time;
- is bound to that account and to the chosen name.

Running the same line again on an enrolled machine only (re)starts the runner. Running it on another machine after use says the code is used, and links to "Add a computer".

## 3. The gaps, in order

Each is meant as one small change. The first unblocks everything else.

1. **A sagebrush release from the current source.** Published 0.10.0 can't enroll on the testing site (step 7). A release, not code.
2. **Enrollment started by the site.** An "add" code made by a signed-in person on the site, redeemed by the machine with its new key: a new route beside the device flow, which stays for `sagebrush remote login`. Single use, short life, bound to the account and the name. Needs a security review of the code in a pasted line: it can end up in shell history and scrollback.
3. **The install script** served at the line's address: platform check, uv install, enrollment, detached start, one-line result. It runs under `sh`, not bash, and refuses clearly when there's no way to fetch.
4. **The runner as a background service.** `sagebrush remote --detach`, or the script's own wrapper, with a log, a pid file and a restart after a crash. `sagebrush remote status` and `stop`. Plus a note that a container's restart needs the line again (or a key kept on a persistent volume).
5. **Add a computer** in the site's UI: the dialog of target step 1, with the live "is connected" turn (it polls the computer list for the new one).
6. **Computers in the menus.** ⋯ ▸ Computers, listing each with Terminal, Notebook and Chat. The terminal item is no longer hidden behind a separate item, and the computer's agents from the list show as Chat entries.
7. **The notebook over the relay.** The relayed notebook path, offered in the "Run on" picker for each computer.
8. **Chat on the computer when it has an agent.** The script detects an agent that's installed and logged in, and starts the runner with it. If there isn't one, Chat here opens the terminal with the one command that sets it up.
9. **The connect page** rewritten around the one line: today's text names an old version and puts the relayed route last.
10. **The main site.** Turning remote compute on there is a decision, not a change, but none of the above reaches people without it.

## 4. Open questions

- **"A whiteboard on that container":** a board whose files live on the computer, or a board that can run code there (like a notebook)? Boards run nothing today.
- **The main site:** when, and for which accounts?
- **Agents on the machine:** is it enough that Chat here says how to log an agent in on the machine, or should the one line offer to set one up too?
- **Containers that restart** (as rented GPU pods do): should the key live on the pod's persistent volume when there is one, so a restart doesn't need a new line?
