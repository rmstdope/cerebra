#!/usr/bin/env bash
set -euo pipefail

readonly image_name='localhost/cerebra-claude-oauth-spike:latest'
readonly first_container="cerebra-resume-first-$$"
readonly state_volume="cerebra-resume-state-$$"

cleanup() {
  podman rm --force "$first_container" >/dev/null 2>&1 || true
  podman volume rm --force "$state_volume" >/dev/null 2>&1 || true
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
podman volume create "$state_volume" >/dev/null

podman run --name "$first_container" --read-only --security-opt no-new-privileges \
  --cap-drop all --tmpfs /tmp --volume "$state_volume:/home/node/.claude:U" \
  --env CLAUDE_CODE_OAUTH_TOKEN "$image_name" npm run start:resume-session
podman rm "$first_container" >/dev/null

podman run --rm --read-only --security-opt no-new-privileges --cap-drop all \
  --tmpfs /tmp --volume "$state_volume:/home/node/.claude:U" \
  --env CLAUDE_CODE_OAUTH_TOKEN --env CLAUDE_SPIKE_RESUME=true \
  "$image_name" npm run start:resume-session
