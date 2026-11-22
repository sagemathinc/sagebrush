# Connecting an agent to Sagebrush: the full reference

The page for people is https://sagebrush.space/agents/connect/: two choices, each with one command. This is everything behind them, for agents and for anyone who wants all of it: each way to connect, what it needs, what it touches, how it behaves with a sandboxed Claude Code, and what isn't there yet.

| Way | Where it works today | What you install | With a sandboxed Claude Code |
|---|---|---|---|
| 1. `sagebrush remote` | dev.sagebrush.space (testing). On sagebrush.space, Connect a computer says whether your account can use it | PyPI `sagebrush` 0.10.3 | Not an agent connection: Claude isn't involved |
| 2. `sagebrush-agent` | The Agents page, /agents/ on sagebrush.space. Claude here; Codex only on a connected computer | `sagebrush-agent` 0.8.6 (a download, not on npm) | Works: it never uses your Claude Code session |
| 3. `sagebrush-mcp` | Math tools anywhere; your Sagebrush files from the notebook page, the LaTeX editor and boards | PyPI `sagebrush-mcp` 0.10.3 | Only if your Claude Code can load MCP servers |
| 4. A cocalc.ai agent | Not yet | — | — |

## 1. `sagebrush remote`: your computer runs a notebook's code

Needs PyPI `sagebrush` 0.10.3 and [uv](https://docs.astral.sh/uv/). The loopback pairing works on dev.sagebrush.space, the testing site, only. For the relayed version, [Connect a computer](https://sagebrush.space/remote/connect) says whether your account can use it.

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

Needs `sagebrush-agent` 0.8.6 (below), Node 20 or later, and Claude Code logged in once with your Claude account. Works with the [Agents page](https://sagebrush.space/agents/) on this site. Codex: not here, only on a [connected computer](https://sagebrush.space/remote/connect).

A small program on your computer runs Claude with your own Claude login. You chat with it in the Agents page, and it works in the files of your Sagebrush workspace in this browser, in the folders you allow.

### Commands

On sagebrush.space:

```
npx -y https://agents.sagebrush.cloud/agents/sagebrush-agent-0.8.6.tgz
```

On dev.sagebrush.space, the testing site (macOS or Linux terminal):

```
SAGEBRUSH_AGENT_PAGE=https://dev.sagebrush.space/agents/ npx -y https://agents.sagebrush.cloud/agents/sagebrush-agent-0.8.6.tgz --origin https://dev.sagebrush.space
```

The sha256 of that file is `6a4e401ace54b5ea046006c2f160820d6950ae5d527291653eb8f6c886175b1e`.

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

Needs PyPI `sagebrush-mcp` 0.10.3, [uv](https://docs.astral.sh/uv/), and an agent that loads MCP servers.

An MCP server your agent starts: Sage and Python tools, and, when you pair a Sagebrush page with it, your Sagebrush workspace files, including notebooks in Python, Sage, MATLAB or Magma that it writes and runs.

### Commands

```
claude mcp add --scope user sagebrush -- uvx sagebrush-mcp@latest
```

`--scope user` makes it Claude Code's in every folder; without it, it is only in the folder you ran the command in. With `@latest`, uv checks for a newer sagebrush-mcp each time the agent starts it, and runs the newest. Added before 0.10.2? Run once: `claude mcp remove sagebrush`, then `claude mcp add --scope user sagebrush -- uvx sagebrush-mcp@latest`. If it runs a `sagebrush-mcp` you installed with pip, `pip install -U sagebrush` upgrades it.

Other agents take a configuration like:

```
{ "mcpServers": { "sagebrush": { "command": "uvx", "args": ["sagebrush-mcp@latest"] } } }
```

To let it work in your Sagebrush files, ask your agent to connect to Sagebrush, or just ask for what you want: until a page is connected, the Sagebrush tools that need your page (the workspace, LaTeX-comment and chat tools) answer with the same link, and once it is connected but before you press Allow, they ask for Allow. Open it in Chrome or Firefox: it opens the notebook page with Connect, the code and port in the link, nothing to type. Press Connect, then Allow. The link works once, for 5 minutes. Chrome and Edge ask once whether this site may reach apps on this computer: click Allow. If you blocked it, allow it again in the site's settings.

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
