#!/bin/sh
# The container's command: enroll this computer once (the approve link and code, as `sagebrush remote login` prints
# them), then serve the account's pages through the relay, with Claude and Codex, from ~/work.  The key lives in the
# home volume, so a restart connects again without a new pairing.
#   SAGEBRUSH_ORIGIN  the site (default https://sagebrush.space); used only for the first enrollment
#   SAGEBRUSH_NAME    the computer's name in "Remote: NAME" (default sagebrush-docker); also only at enrollment
# Any arguments replace the agents (they are given to `sagebrush remote` as they are).
set -eu
mkdir -p "$HOME/work"
cd "$HOME/work"
key="${XDG_CONFIG_HOME:-$HOME/.config}/sagebrush/remote/key.json"
if [ ! -f "$key" ]; then
  sagebrush remote login --origin "${SAGEBRUSH_ORIGIN:-https://sagebrush.space}" --name "${SAGEBRUSH_NAME:-sagebrush-docker}"
fi
if [ "$#" -gt 0 ]; then
  exec sagebrush remote "$@"
fi
exec sagebrush remote --serve-agents \
  --agent claude="sagebrush-agent --stdio" \
  --agent codex="sagebrush-agent --codex --stdio"
