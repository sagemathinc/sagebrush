# Connecting an agent to Sagebrush: the full reference

The page for people is https://sagebrush.space/agents/connect/: three choices, each with one command. This is everything behind them, for agents and for anyone who wants all of it: each way to connect, what it needs, what it touches, how it behaves with a sandboxed Claude Code, and what isn't there yet.

| Way | Where it works today | What you install | With a sandboxed Claude Code |
|---|---|---|---|
| 1. `sagebrush remote` | dev.sagebrush.space (testing). On sagebrush.space, Connect a computer says whether your account can use it | PyPI `sagebrush` 0.10.1 | Not an agent connection: Claude isn't involved |
| 2. `sagebrush-agent` | The Agents page, /agents/ on sagebrush.space. Claude here; Codex only on a connected computer | `sagebrush-agent` 0.7.1 (a download, not on npm) | Works: it never uses your Claude Code session |
| 3. `sagebrush-mcp` | Math tools anywhere; your Sagebrush files from the notebook page, the LaTeX editor and boards | PyPI `sagebrush-mcp` 0.10.1 | Only if your Claude Code can load MCP servers |
| 4. A cocalc.ai agent | Not yet | — | — |
| 5. claude.ai or ChatGPT artifacts | In the chat app's artifact; no Sagebrush files | Nothing: npm `sagebrush-web` 0.10.1 from a CDN | Not affected: it runs in the chat app in your browser |

## 1. `sagebrush remote`: your computer runs a notebook's code

Needs PyPI `sagebrush` 0.10.1 and [uv](https://docs.astral.sh/uv/). The loopback pairing works on dev.sagebrush.space, the testing site, only. For the relayed version, [Connect a computer](https://sagebrush.space/remote/connect) says whether your account can use it.

On the testing site, a notebook sends the cells you run to a Python on your computer instead of the one in your browser. An agent isn't part of it.

### Commands

On the testing site, run this in a terminal, in the folder the notebook's code should start in:

```
SAGEBRUSH_KERNEL_DEV_ORIGIN=https://dev.sagebrush.space uvx sagebrush@latest remote --loopback
```

It prints a link and a one-time code. Open the link in Chrome and click Connect. The browser asks once whether this site may reach apps on this computer: click Allow. If you blocked it, allow it again in the site's settings.

There is also a relayed version, with a terminal on your computer: open [Connect a computer](https://sagebrush.space/remote/connect) on this site. It says first whether your account can use it, and only then shows the commands for it.

### What it touches

- **With `--loopback`:** the cells you run execute in that Python, under your account, with your files and network, starting in the folder you ran the command in. It listens on 127.0.0.1 only, and accepts one page, after the code.
- **Relayed:** the same, plus an outbound connection to Sagebrush's relay, and, when you open the terminal, a login shell under your account on this computer.
- Ctrl+C in the terminal stops it.

### Not yet

- On sagebrush.space: the loopback pairing.
- Without `SAGEBRUSH_KERNEL_DEV_ORIGIN`, the printed link points at sagebrush.space, which doesn't have this yet.

## 2. `sagebrush-agent`: Claude on your computer, the chat in your browser

Needs `sagebrush-agent` 0.7.1 (below), Node 20 or later, and Claude Code logged in once with your Claude account. Works with the [Agents page](https://sagebrush.space/agents/) on this site. Codex: not here, only on a [connected computer](https://sagebrush.space/remote/connect).

A small program on your computer runs Claude with your own Claude login. You chat with it in the Agents page, and it works in the files of your Sagebrush workspace in this browser, in the folders you allow.

### Commands

On sagebrush.space:

```
npx -y https://agents.sagebrush.cloud/agents/sagebrush-agent-0.7.1.tgz
```

On dev.sagebrush.space, the testing site (macOS or Linux terminal):

```
SAGEBRUSH_AGENT_PAGE=https://dev.sagebrush.space/agents/ npx -y https://agents.sagebrush.cloud/agents/sagebrush-agent-0.7.1.tgz --origin https://dev.sagebrush.space
```

The sha256 of that file is `2a131b9381de4b5d011bebc482dda7d2e13402f68a58b60dfba740fa18e0931c`.

- It prints a link with a one-time code. Open it in Chrome or Firefox. Safari can't reach a program on your computer.
- The browser asks once whether this site may reach apps on this computer; its wording depends on the browser's version. Click Allow, then Connect again if it asks.
- Choose the folders Claude may use.

The printed link opens sagebrush.space. On dev.sagebrush.space without `SAGEBRUSH_AGENT_PAGE` (for example on Windows, where the command above doesn't set it), open the [Agents page](https://sagebrush.space/agents/) here, click “Connect Claude”, and type the code and the port the program printed.

If you clicked Block by mistake: click the icon at the left of the address bar, open Site settings, allow that permission, and reload the page.

### What it touches

- **On your computer:** one Node process under your account. It works in an empty temporary folder, loads none of your Claude settings or MCP servers, and listens on 127.0.0.1 only. It accepts only sagebrush.space, the preview site and any `--origin` you add, only with the one-time code (used once, valid 5 minutes), and one page at a time.
- **What Claude can use:** no shell and none of your computer's files. Its file tools are the Sagebrush workspace's, and the page checks each call against the folders you allowed. Each web search or fetch asks you first in the chat, and so does each move, rename or removal of a file. It can write a notebook. On pages that offer branches it can also make its own branch and ask you to review it; only you accept its changes. It runs code only while "May run code" is on, and then in Sagebrush's sandbox in your browser, never on this computer; otherwise you run a notebook's cells.
- **Network:** the program talks to Anthropic, with your Claude login. Your conversation goes to Anthropic.
- **On disk:** while it runs, each conversation's transcript is saved under `~/.claude/projects/`, as Claude Code does, including the contents of files Claude read. Ctrl+C stops it and deletes this run's transcripts and its temporary folder; if it can't, it says what's left. If the program is killed or crashes, the transcripts stay until you delete them.

### With a sandboxed Claude Code

It works: it's a separate program and never uses your Claude Code session, sandbox settings or MCP configuration. It needs the program itself to reach Anthropic, and your browser to reach 127.0.0.1. If a policy on your computer blocks programs' outbound network, it can't work. Option 3's math tools need no outbound network once installed; option 5 might also work.

### Not yet

- Codex here: it runs only on a [connected computer](https://sagebrush.space/remote/connect).
- An npm or PyPI package: for now it's the download above.

## 3. `sagebrush-mcp`: Sagebrush's tools in the agent you already run

Needs PyPI `sagebrush-mcp` 0.10.1, [uv](https://docs.astral.sh/uv/), and an agent that loads MCP servers.

An MCP server your agent starts: Sage and Python tools, and, when you pair a Sagebrush page with it, your Sagebrush workspace files, including notebooks in Python, Sage, MATLAB or Magma that it writes and runs.

### Commands

```
claude mcp add --scope user sagebrush -- uvx sagebrush-mcp
```

`--scope user` makes it Claude Code's in every folder; without it, it is only in the folder you ran the command in.

Other agents take a configuration like:

```
{ "mcpServers": { "sagebrush": { "command": "uvx", "args": ["sagebrush-mcp"] } } }
```

To let it work in your Sagebrush files, ask your agent to connect to Sagebrush. It gives a link that opens the notebook page with its code and port filled in, or the code and the port to type in: enter them with the Agent button on the notebook page or in the LaTeX editor, or with Connect an agent… in a board's ⋯ menu or a code file's File menu. Chrome and Edge ask once whether this site may reach apps on this computer: click Allow. If you blocked it, allow it again in the site's settings.

### What it touches

- Your agent starts it under your account, in the agent's working folder.
- The Sage and Python tools run code in that process's Python, with your files and network as that process sees them. If your agent limits the programs it starts, that applies to it too.
- For your Sagebrush files, it listens on 127.0.0.1, and a page pairs with it by the one-time code. Each file call then goes through what you allowed in that page.

### With a sandboxed Claude Code

Doesn't work if your Claude Code can't load MCP servers. The math tools alone need no network and no page; pairing with a page needs the server to listen on 127.0.0.1.

### Not yet

- We haven't tried it with Codex yet.

## 4. An agent in a cocalc.ai project

Not yet. Not built.

The plan: an agent in a cocalc.ai project works in your Sagebrush workspace, with access you grant on sagebrush.space. It needs Sagebrush's sync, which isn't on yet.

What works today: a cocalc.ai project can be the computer for option 1 (on the testing site), and `sagebrush-mcp`'s math tools work in a project. A page can't pair with a server in a project, because your browser's 127.0.0.1 isn't the project's.

## 5. Sagebrush in claude.ai or ChatGPT artifacts

Nothing to install: npm `sagebrush-web` 0.10.1, from the jsDelivr CDN.

Sagebrush's math engines in one JavaScript module that an artifact in the chat app can import. Ask the chat to use it in an artifact:

```
const sb = await import("https://cdn.jsdelivr.net/npm/sagebrush-web@0.10.1/sagebrush-engine.mjs");
```

### What it touches

- The code runs inside the artifact, in your browser. Nothing runs on your computer outside the browser, and it doesn't use sagebrush.space or your Sagebrush files.
- The browser downloads about 3 MB from cdn.jsdelivr.net.

### With a sandboxed Claude Code

Not affected: it's the claude.ai web app, not Claude Code.

### Not yet

- It's the engines' functions only: no Sage session, no notebook, no files, and no link to your sagebrush.space work.
- Last tried in October: Claude's artifacts allowed `import()` from cdn.jsdelivr.net (not other CDNs); ChatGPT's allowed more.
