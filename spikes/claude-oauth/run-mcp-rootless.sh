#!/usr/bin/env bash
set -euo pipefail

readonly image_name='localhost/cerebra-claude-oauth-spike:latest'
readonly network_name="cerebra-mcp-spike-$$"
readonly server_name="cerebra-mcp-tool-server-$$"

cleanup() {
  podman rm --force "$server_name" >/dev/null 2>&1 || true
  podman network rm "$network_name" >/dev/null 2>&1 || true
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

if [[ "${MCP_BEARER_TOKEN:-}" == '' ]]; then
  printf '%s\n' 'MCP_BEARER_TOKEN must be set before running this spike.' >&2
  exit 1
fi

if [[ "$(podman info --format '{{.Host.Security.Rootless}}')" != 'true' ]]; then
  printf '%s\n' 'This spike requires rootless Podman.' >&2
  exit 1
fi

podman build --tag "$image_name" --file Containerfile .
podman network create "$network_name" >/dev/null
podman run --detach --name "$server_name" --network "$network_name" \
  --network-alias mcp-tool-server --read-only --security-opt no-new-privileges \
  --cap-drop all --env MCP_BEARER_TOKEN "$image_name" \
  node src/mcp-tool-server.mjs >/dev/null

podman run --rm --network "$network_name" --read-only \
  --security-opt no-new-privileges --cap-drop all --tmpfs /tmp \
  --tmpfs /home/node/.claude --env CLAUDE_CODE_OAUTH_TOKEN \
  --env MCP_BEARER_TOKEN "$image_name" npm run start:mcp-tool-call
podman logs "$server_name"
