#!/usr/bin/env bash
set -euo pipefail

readonly image_name='localhost/cerebra-claude-oauth-spike:latest'

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
podman run --rm --read-only --security-opt no-new-privileges \
  --cap-drop all --tmpfs /tmp --tmpfs /home/node/.claude \
  --env CLAUDE_CODE_OAUTH_TOKEN "$image_name" npm run start:stream-input
