#!/usr/bin/env bash
set -euo pipefail

readonly image_name='localhost/cerebra-claude-oauth-spike:latest'
readonly network_name="cerebra-claude-oauth-spike-$$"
readonly relay_name="cerebra-question-relay-spike-$$"
relay_output=''

cleanup() {
  podman rm --force "$relay_name" >/dev/null 2>&1 || true
  podman network rm "$network_name" >/dev/null 2>&1 || true
  if [[ "$relay_output" != '' ]]; then
    rm -f "$relay_output"
  fi
}

trap cleanup EXIT

if ! command -v podman >/dev/null 2>&1; then
  printf '%s\n' 'Podman is required to run this rootless runtime spike.' >&2
  exit 1
fi

if [[ "${CLAUDE_CODE_OAUTH_TOKEN:-}" == '' ]]; then
  printf '%s\n' 'CLAUDE_CODE_OAUTH_TOKEN must be set before running this spike.' >&2
  exit 1
fi

if [[ "$(podman info --format '{{.Host.Security.Rootless}}')" != 'true' ]]; then
  printf '%s\n' 'This spike requires rootless Podman.' >&2
  exit 1
fi

podman build --tag "$image_name" --file Containerfile .
podman network create "$network_name" >/dev/null
podman run --detach --name "$relay_name" --network "$network_name" \
  --network-alias question-relay \
  --read-only --security-opt no-new-privileges --cap-drop all \
  "$image_name" node src/question-relay.mjs >/dev/null

relay_output="$(mktemp)"
podman run --rm --network "$network_name" --read-only --security-opt no-new-privileges \
  --cap-drop all --tmpfs /tmp --tmpfs /home/node/.claude \
  --env CLAUDE_CODE_OAUTH_TOKEN "$image_name" >"$relay_output"
podman logs "$relay_name"
cat "$relay_output"
