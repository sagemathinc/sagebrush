# Pair in a tab: Claude in the browser, with nothing installed

*Status: r1, a design note; nothing is built. Owner: the space lane. It rests on the unkernel spike of Nov 22, 2026: Claude Code 2.1.314, Anthropic's own closed-source arm64 binary, ran unmodified inside unkernel (Linux compiled to WebAssembly) in a tab. sagebrush-agent paired with it over vsock, and a real turn came back. To review: SEC (the guest, logins, the relay), COPY.*

**In plain words.** One more choice on the Agents page: **Claude in this tab**.
- The page starts a small Linux machine in the tab, with Node and `sagebrush-agent` already inside, and pairs with it. There is no install, no terminal and no code to type.
- The person logs in to Claude once, inside that machine. The login stays in their browser.
- The machine reaches Anthropic only through **our relay**, part of a paid plan; a browser can't open TCP connections.
- Math runs in the page's engine, never in the machine.

## 1. Where it lives

| | Where | For | Against |
| --- | --- | --- | --- |
| **A** | **sagebrush.space/agents/**, beside "this computer" and "a connected computer" | Same origin as the workspace, so `agent-pair.ts` works as it is: its `WebSocketImpl` takes a WebSocket over `vm.connect()` (vsock), and every workspace call is the page's own | The page must be cross-origin isolated (COOP/COEP; /space/ is, /agents/ needs checking). About 125 MB downloaded lazily on first use |
| B | agents.sagebrush.cloud, its own page | Isolates the machine from the site | It can't reach sagebrush.space's workspace without a cross-origin bridge, and it splits the product |
| C | The desktop app (#1498) | Native speed | It isn't "nothing installed" |

**Recommendation: A.** The kernel (a pinned unkernel release, served unmodified, with a link to its GPL source), the Debian image and our agent disk come from our static origin by Range request, each pinned by hash.

## 2. Logins

- **Where it lives:** Claude Code keeps its login in `~/.claude` in the guest. **Recommendation:** put `~/.claude` on a small 9p mount that the page serves from its own IndexedDB store (one browser and one origin, never our servers). Then:
  - "Sign out of Claude in this tab" deletes exactly that store;
  - the main disk never holds a credential.
- **Never in a snapshot.** A snapshot holds the whole machine, so only snapshots taken *before* login are kept or shipped. The 9p mount keeps the login out of them by construction. *To verify:* a restore keeps host mounts.
- **How the person logs in:** a terminal on the page runs `claude`. They open the link it prints and paste the code back, as William did on Nov 22. Nothing passes through our code: TLS stays inside the guest, and the relay only carries bytes. The page never records the terminal's text.

## 3. Speed

- **Cold start:** boot 1.0 s, paired 15.3 s.
- **Resuming a pre-login snapshot:** paired about 2–3 s after the page loads (Chrome).
- **Saving a snapshot:** runs in a worker; the page freezes about 0.1 s.
- **Guest memory:** 1 GiB, because Chrome refuses a single buffer over 2046 MiB (an upstream fix is drafted).
- **A turn** (William's real one): 45.6 s from the message to the end.
  - About 30 s is **Claude Code starting**: CPU work per process, measured at 27–32 s cold, warm, or resumed from a pre-login snapshot.
  - About 4 s is the SDK and agent, and about 11 s is the API.
  - **A pre-login snapshot doesn't shorten a turn.** sagebrush-agent starts a new Claude Code process for every turn (one `query()` per turn, resumed by session id).
  - **Recommendation (an agent change):** keep one Claude Code process alive per conversation and feed it each message as streaming input, as Steer already does. Then only a conversation's first turn pays the 30 s.

## 4. The network in a tab

- **Without a relay** the guest has no internet. It has:
  - vsock to the page (pairing, and the page's engine at 50–85 ms a call);
  - 9p mounts;
  - at most unkernel's `fetchRoutes`: plain-HTTP GET and HEAD through the page's `fetch()`, to hosts that allow CORS.

  None of that carries Claude's HTTPS. So no relay means no Claude in a tab, and the page then offers the other two ways to connect.
- **The relay:**
  - a Wisp server (the protocol unkernel speaks);
  - an allow list by host name (Anthropic, OpenAI, Debian, npm, PyPI, GitHub);
  - per-user tokens from the paid plan;
  - metering of bytes and time.
- **Not on Cloudflare Workers.** Tested Nov 22: connecting by host name, Workers couldn't reach Anthropic, OpenAI or npm, and Cloudflare's terms (§2.2.1(j)) forbid proxy services.
- **Where instead:** Fly.io (anycast, about 35 regions), or two or three VPS regions that unkernel's client races and uses whichever answers first. Options and costs are in the spike's hosting notes. Not deployed until the spend is approved.
- **Later:** Chrome's Direct Sockets would need no relay, but it is for Isolated Web Apps only (enterprise-installed and allowlisted, as of Nov 2026) and it's Chrome-only.

## 5. One session, any device (later)

William's story: work on one laptop, turn it off, continue the same session from another laptop or a phone. It's about where the state lives:

| State | Where | Picked up by |
| --- | --- | --- |
| Workspace files | Our cloud (synced today) | As today |
| The conversation: Claude Code's transcript (`~/.claude/projects/<folder>/<id>.jsonl`) and the agent's chat log | Uploaded after each turn | The new guest writes them back; the agent resumes the session by its id |
| Logins | Each device's own, never synced | One login per device |
| The machine | Our pinned files, or a pre-login snapshot | Downloaded on first use |

It needs:
- the agent to keep and sync transcripts, where today it deletes them when it stops;
- the same working-folder path in every guest;
- a lease, so that one device runs a turn at a time.

A turn runs on the device that started it. A phone that stops background work picks the session up again when it's reopened. A turn that runs with every device off is Delegate on a server, a different product.

## 6. Not in the first version

- Codex (same design, via the relay).
- Delegate in a tab (it works in the spike).
- Several CPUs.
- A second tab: the disk is one tab's at a time, so a second tab says so.
- Browsers without JSPI: the page checks first (`checkSupport()`) and says plainly what to update ("…needs Safari 27 or later"), never failing silently.
