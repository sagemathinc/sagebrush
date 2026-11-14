# Sagebrush remote in a container

One line runs `sagebrush remote`, with Claude and Codex, inside a Docker container. Nothing is installed on your
machine but Docker:

```sh
docker run -it -v sagebrush-remote:/home/sb ghcr.io/sagemathinc/sagebrush-remote
```

It prints a link and a code. Open the link signed in to Sagebrush, check the code, and approve. (Connecting a computer isn't open to every account yet: the approve page says so if yours can't.) The container then
says "Connected", and a notebook's run menu (next to Run all) lists it as "Remote: sagebrush-docker". Choose it, and
the cells you run go to Python in the container. ⋯ ▸ Terminal on your computer opens a shell in it.

- **Keep it connected:** the volume (`-v sagebrush-remote:/home/sb`) holds the container's key, the agents' logins and
  your files in `~/work`. Stop and start the container, or run a newer image, with the same volume, and it connects
  again without a new pairing. Without `-v`, each new container (each `docker run`) pairs a new computer; restarting the same container doesn't.
- **Name it:** `-e SAGEBRUSH_NAME=lab-box` on the first run (it's set when the computer is approved).
- **The testing site:** `-e SAGEBRUSH_ORIGIN=https://dev.sagebrush.space` on the first run.
- **Run it in the background:** add `-d --restart unless-stopped`. On the first run, `docker logs` shows the link and code.
- **Install more:** the user is `sb`, with `sudo` and no password, so `sudo apt-get install …`, `uv pip install …` and
  the agents can add what they need, inside the container only.

What's inside: Debian stable (slim), `uv` and `uvx`, `sagebrush` from PyPI, Node, and `sagebrush-agent`, which brings
its own pinned Claude Code (in its locked dependencies) and Codex (fetched on first use and checked by its hash). uv, sagebrush and sagebrush-agent are at pinned versions (docker/remote/Dockerfile); Debian and its Node are Debian stable's when the image is built.

## What the container protects, and what it doesn't

It's a convenient way to try Sagebrush remote with one extra layer between the code and your machine. It isn't a
security boundary against a determined attacker.

**It helps with:**
- **Your files.** Code from a notebook, a terminal or an agent sees the container's own files, its volume, and only
  what you mount into it (nothing, with the line above). It can't read or change your home folder.
- **Your machine's setup.** `sudo apt-get install` and the like change the container, not your machine. Remove the
  container and the volume, and everything it did is gone.
- **Your processes.** Code in the container can't see or signal the programs running on your machine.
- **On Mac and Windows,** Docker Desktop runs containers in a Linux virtual machine, a second boundary.

**It doesn't help with:**
- **The network.** The container can reach anything your machine can reach: your local network, cloud metadata
  endpoints, the internet. Run it where that's acceptable, or give it a restricted Docker network.
- **What's inside it.** Anything running in the container can read the volume, which holds the container's Sagebrush
  key and the agents' logins (for example your Claude or Codex login), and can act with them.
- **Escapes.** A bug in the Linux kernel or in Docker can let code out of a container. Keep Docker up to date, and don't
  add `--privileged`, the Docker socket, or broad mounts.
- **Your Sagebrush account.** Anyone signed in to your Sagebrush account can run code in the container, as on any
  computer you connect. Revoking the computer stops that.
- **The relay.** The container's connection goes through Sagebrush's relay, as any computer's does.

## Building and testing

```sh
docker build -t sagebrush-remote:dev docker/remote
docker/remote/smoke.sh sagebrush-remote:dev
```

The smoke test starts the image against the repository's fake relay (engine/py/test_remote_relay.py), connects, pairs
a page and runs a cell, which must print 42 from `~/work`; it checks that both agents are offered and that the runner is
`sb`. Then it removes the container and starts a new one on the same volume, which must connect with the volume's key,
and runs the cell again. Nothing leaves the machine.
