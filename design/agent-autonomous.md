# Autonomous agents: a fleet of hosts working in a Sagebrush workspace

*Status: draft, for William's ruling. Nothing is built, and no code starts until he rules. It answers the brief: where it runs, wake sources, durable state, permissions, spend and safety, the UI, and the MVP and its size. William's inputs of Nov 22, 2026 decide where they differ from that brief: a fleet of hosts, permissions as agent configuration, and running Sagebrush development as the acceptance test. The sections on syncing on a host and on the in-tab host were checked with the lanes that own those parts.*

## In plain words

- **A third agent mode, Autonomous, beside Pair and Delegate.** An autonomous agent wakes by itself (at a time, when a workspace file changes, when a message arrives), does a turn of work, and sleeps again. It has memory, an inbox and messaging. Pair and Delegate don't change and get none of this.
- **It runs on hosts you own and leave on:** a server, a laptop, a GPU box or a cloud VM. Each runs one program, `sagebrush-agent host`, which runs that machine's agents. Many hosts make a fleet.
- **The workspace is the shared place:** progress boards and the markdown agents share with each other and with you. Builds, repositories and GPUs stay on the hosts.
- **Permissions are configuration,** written per agent on each host by its owner. A coordinator on its own VM may have everything there; the agents working for it get less. There are no per-folder grant cards.
- **You can always see, pause and stop it.** There is an activity log, daily budgets per agent, and pause and stop for one agent, a host, or everything.

## 1. Where it runs

- **On a host:** `sagebrush-agent host <config>`, a long-running process on any always-on machine the person controls. It uses that machine's own Claude or Codex login, as Pair does on the person's computer.
- **Several hosts per person:** each host appears in the fleet with its agents. A host runs at most N turns at once (configured; default 4).
- **Not in a browser tab.** A tab isn't on when the computer is off, and that is exactly when Autonomous matters. Browsers also throttle and discard background tabs. In the in-tab Linux guest, Claude Code takes 15–30 s to start (measured), and the guest is capped at 1 GiB, so builds and GPUs are out anyway. A suspended tab can resume and catch up on its inbox, but it is never counted on for a wake. Tabs are left out of v1.
- **Cloud-hosted later:** the same `host` program on a managed VM, for people without a machine to leave on.

## 2. The workspace, from a host

- **v1: no local copy.** Agents read and write the workspace through the agent endpoint (design/agent-endpoint.md): list, stat, read, write, create, mkdir, rename, remove, restore, history, version. It exists today behind the sync flag. Builds stay in each host's own folders.
- **One grant per host,** minted by the endpoint's device-code pairing: the host shows a link and a code, and the person approves on sagebrush.space. They can narrow its paths, never widen them. The token is stored 0600 and sent only as a bearer header. Revoking it cuts that host off.
- **Writes are compare-and-swap.** A file that moved since it was read answers `conflict`, and the agent re-reads and retries; nothing is lost silently. So **one hot file means retries**:
  - status goes in per-agent files or per-agent board cards, never one shared file every agent rewrites;
  - messages never go in workspace files (§5).
- **Later:** a local mirror (fs-sync in a loop plus a change cursor) for tools that need files on disk.
- **Open:**
  1. Grants default to 30 days, capped by the membership. An always-on host needs a renewal story: a reminder before expiry, or a longer cap for hosts.
  2. A `changes(since, timeout)` long-poll on the endpoint, so file-change wakes don't need polling.
  3. An append verb for documents, to cut retries.

## 3. Agents and their permissions: configuration per host

A host's config (`~/.sagebrush/host.json`, the owner's file, 0600) lists its agents. Each agent has:
- `name`, `client` (claude or codex), and `role`: its standing instructions.
- `workspace`: the paths it may read and write, within the host's grant.
- `local`:
  - folders it may use (worktrees, build folders);
  - `shell`: none | confined (its folders only, OS-sandboxed) | full;
  - `network`: none | an allow list | full;
  - `gpu`: yes | no.
- `wakes` (§4), `budget` (§6), and `peers`: who may message it (default: the person and this fleet).
- `ask`: actions that need the person's OK every time (below).

Bounds:
- The host's grant bounds what any agent touches in the workspace.
- The machine's account bounds what it touches locally.
- Each agent's config narrows both.
- No agent can change the config: it isn't in any agent's folders, and a change takes effect only when the owner reloads the host, which logs it.

**Example:** the coordinator on its own VM has `shell: full`, root included, and `network: full`. A worker has `shell: confined` to its worktree, and `network` limited to git, npm and PyPI.

**Always the person's OK**, whatever the config says, as a high-priority question in their inbox:
- spending money;
- anything public (publishing, a post, a release);
- deleting outside its own folders;
- widening any agent's config.

Per agent, the owner may add to this list, for example pushing to shared branches or merging. They can never remove from it.

## 4. Wakes

- **Each wake is a turn** in that agent's own conversation (its session, resumed), run by the turn machinery Pair already has, with the config's tools. An agent runs one turn at a time. Wakes that arrive during a turn are folded into one "while you worked: …" message at the start of its next turn.
- **v1 wakes:**
  - **time:** `at` and `every`;
  - **a workspace path changing:** polled through the endpoint's `version`, every 30–60 s per watched path, until the long-poll exists;
  - **a message to the agent.**
- **Later:**
  - a command's exit, which is how waiting for CI works;
  - an incoming webhook;
  - a host-local file.

## 5. Coordination: messages, inbox, memory

**Messages need a service, not files.** At hundreds a day, with priority and rate limits, they go through a small message service in the Sagebrush cloud: a Worker plus one Durable Object per account. Hosts and the page connect to it. It never makes an outbound connection.

- **A message:**
  - `from`, `to` (an agent, or "the person"), `thread`;
  - `subject` (≤ 120 chars), `priority` (low | normal | high), `body` (markdown, ≤ 64 KiB);
  - attachments as workspace paths.
- **Delivery:** "accepted" means it is in the recipient's inbox, not that it was answered. A reply keeps its thread.
- **A directory** lists the person's agents, with host, status and peers.
- **Limits** (starting values):
  - per sender: 60 a minute and 3,000 a day;
  - per recipient: 2,000 unread;
  - a message wakes a recipient at most once every 30 s, with the rest folded in.
- **Each turn has a subject and a priority,** set by the agent. These make the person's inbox one item per turn.
- **Memory:** notes in the workspace under `/.agents/memory/<namespace>/<name>.md`, so they sync, every host sees them, and the person can read and edit them.
  - 8 KB per note, 500 per namespace, each with a one-line description for its index.
  - Each agent also gets a private namespace for its working state; those notes expire after 30 days unused.
  - Agents use them through list, search, read, write and delete tools, compare-and-swap like any write.

## 6. Spend and safety

- **Budgets per agent:** turns a day, tokens a day (from the SDK's own usage), and wall time per turn (default 2 h). Past one, the agent sleeps until the next day and says so in a low-priority message. The person can raise the budget.
- **The activity log:**
  - every turn's full events stay on its host, in the chat log format Pair already writes;
  - one line per turn goes to the service: agent, wake source, subject, tokens, outcome.
- **Pause and stop:** one click, for one agent, one host or everything.
  - It goes through the service to the host, which stops running turns the way Pair's Stop does and ignores wakes until resumed.
  - Revoking a host's grant cuts its workspace access and its messaging at once.

## 7. The UI

- **The Agents page gets a third choice:** Pair · Delegate · Autonomous.
- **Autonomous shows:**
  - **the fleet:** each host and its agents, with status (idle, working, paused, asleep on its budget), last wake and today's spend;
  - **each agent's thread:** its turns, read-only, and a reply box that sends a message;
  - **the person's inbox:** high priority first, open questions on top;
  - **pause, resume and stop** buttons;
  - **each agent's config,** read-only.
- Answering a question is replying in its thread.

## 8. The acceptance test: running Sagebrush development on it

Today's Sagebrush development runs on an agent network much like this one: a coordinator, about 40 agents with roles, review lanes, CI watchers, memory notes, and hundreds of messages a day.

| What development uses today | In this design |
| --- | --- |
| A coordinator with full rights on its VM; workers with less | §3 config |
| Hundreds of messages a day, threads, priority, turn subjects | §5 service |
| Review lanes | Agents whose wake is a review request message |
| Memory notes, per agent and shared | §5 memory |
| CI watchers | v1: a time wake that checks CI; later: the exit wake |
| Waking at a time | §4 |
| The person's QA and rulings | The inbox and replies |
| Pause everything | §6 |

**Not in v1:**
- cards for PRs and commits, which stay links to workspace files;
- exit and webhook wakes;
- a host on macOS or Windows with `shell: confined`: their OS sandboxes come later; `none` or `full` works there.

## 9. The MVP slice and its size

**Stage 1**, in the order to build:

| Part | Scope | Size |
| --- | --- | --- |
| `sagebrush-agent host` | config and its reload; time, message and workspace-poll wakes; per-agent conversations on the existing turn machinery; budgets; activity log; pause and stop; Linux first | about 1,500–2,000 lines, 1.5–2 weeks |
| The message service | send, inbox, threads, receipts, directory, rate limits; the host's grant as its credential | about 800 lines, 1 week |
| Memory and workspace tools for agents | over the agent endpoint | about 300 lines, 2–3 days |
| The page | the Autonomous tab: fleet, threads, inbox, pause and stop | 1–1.5 weeks |

In all, about 4–5 weeks, with each part reviewed as it lands. A useful slice comes earlier: one host, two agents, time and message wakes, and the inbox on the page.

**Stage 2:**
- the endpoint's change long-poll;
- exit and webhook wakes;
- a local mirror of the workspace;
- cloud-hosted hosts;
- `shell: confined` on macOS;
- grant renewal for hosts.

**For William to decide:**
1. The host credential's lifetime (§2).
2. Whether the message service is v1 (as proposed) or v1 makes do with workspace files at low volume. The second is simpler, but fails the acceptance test.
3. The default "always ask" list (§3).
4. The starting budget and rate-limit values (§5, §6).
