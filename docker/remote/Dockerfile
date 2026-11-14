# Sagebrush remote in a container: `sagebrush remote` with its agents, and everything they need, so trying it on any
# machine with Docker takes one line and installs nothing on the host (docker/remote/README.md says what that does
# and doesn't protect).
#
#   docker run -it -v sagebrush-remote:/home/sb ghcr.io/sagemathinc/sagebrush-remote
#
# - Debian stable, slim; a user `sb` with passwordless sudo, so code and agents can `sudo apt-get install` inside.
# - uv and uvx at a pinned version; sagebrush from PyPI at a pinned version, in its own Python (outside /home/sb, so
#   the volume holds only state and an image update reaches every container).
# - sagebrush-agent at a pinned version, its tarball checked by sha256; it fetches its own pinned, hash-checked Codex
#   and uses Claude Code from its own dependencies, into ~/.cache, on first use.
# - /home/sb is the volume: the computer's key (~/.config/sagebrush/remote/key.json), the agents' logins, and the
#   folder the notebook and terminal start in (~/work). A restart, or a new image, keeps them: no new pairing.
ARG UV_VERSION=0.11.25
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

FROM debian:stable-slim
ARG SAGEBRUSH_VERSION=0.10.1
ARG AGENT_VERSION=0.7.1
ARG AGENT_SHA256=2a131b9381de4b5d011bebc482dda7d2e13402f68a58b60dfba740fa18e0931c
ARG PYTHON_VERSION=3.13

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git less procps sudo tini nodejs \
 && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /uvx /usr/local/bin/

# (sagebrush and its Python, outside the home volume)
ENV UV_TOOL_DIR=/opt/sagebrush/tools UV_TOOL_BIN_DIR=/usr/local/bin UV_PYTHON_INSTALL_DIR=/opt/sagebrush/python \
    UV_NO_CACHE=1
RUN uv tool install --python "${PYTHON_VERSION}" "sagebrush==${SAGEBRUSH_VERSION}" \
 && sagebrush --version

# (the agent, checked by its sha256 before it is installed; npm only for this step, and in this one layer: its cache,
# npm itself and the musl build of Claude Code's binaries, which this glibc image never runs, are gone after it)
RUN apt-get update && apt-get install -y --no-install-recommends npm \
 && curl -fsSLo /tmp/agent.tgz "https://agents.sagebrush.cloud/agents/sagebrush-agent-${AGENT_VERSION}.tgz" \
 && echo "${AGENT_SHA256}  /tmp/agent.tgz" | sha256sum -c - \
 && npm install -g --no-fund --no-audit /tmp/agent.tgz \
 && rm -rf /tmp/agent.tgz /root/.npm /usr/local/lib/node_modules/sagebrush-agent/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl \
 && apt-get purge -y npm && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && sagebrush-agent --help >/dev/null \
 && node -e 'require.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/package.json", { paths: ["/usr/local/lib/node_modules/sagebrush-agent"] })' 

RUN useradd --create-home --shell /bin/bash sb \
 && printf 'sb ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/sb \
 && chmod 0440 /etc/sudoers.d/sb

COPY entrypoint.sh /usr/local/bin/sagebrush-remote-entry
RUN chmod 0755 /usr/local/bin/sagebrush-remote-entry

USER sb
ENV HOME=/home/sb
WORKDIR /home/sb
VOLUME /home/sb
LABEL org.opencontainers.image.source="https://github.com/sagemathinc/sagebrush" \
      org.opencontainers.image.description="sagebrush remote with its agents: run a Sagebrush notebook's code, terminal and agents in this container" \
      org.opencontainers.image.licenses="MIT"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sagebrush-remote-entry"]
