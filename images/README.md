# Images

Containerfiles for Cerebra's two images (architecture §12). Build both from the repository root.

## `cerebro-main`

The backend and the web UI, with Git and CA certificates for GitHub discovery and mirror cloning.
Dependency installation caps Node's heap and download concurrency to reduce build memory usage.
If the default 2 GB Podman machine kills a build with exit status 137, stop Cerebra's containers
with `podman compose --file images/podman-compose.yml stop`, then retry `./cerebra update`.
This keeps the persistent volumes and master-key secret.

```sh
podman build -f images/main.Containerfile -t cerebro-main .
```

For the local application use `./cerebra start` from the repository root instead of invoking
Compose directly on a fresh installation. The launcher provisions the persistent external Podman
secret `cerebra-project-token-key`; Compose mounts it only in `main` at
`/run/secrets/cerebra-project-token-key`. `CEREBRA_PROJECT_TOKEN_KEY_FILE` points to that file, and
an unreadable or malformed key prevents startup. Never replace this secret on updates: existing
credentials depend on it. See the root README for legacy-key migration and backup guidance.

The private `database` network connects only `main` and Postgres. The main container also joins
`internal` for runners and `egress` for GitHub HTTPS and Git. Only the web port is published, on
`127.0.0.1:4317`; Postgres has no host port.

Project discovery uses GitHub API Bearer authentication; mirror cloning uses Git-over-HTTPS
Basic authentication with the token as the password. The Git header is passed only in the clone
process environment, never in the repository URL or saved Git configuration. Cloning is
non-interactive: a rejected token fails registration rather than prompting for credentials.

Failed clones write a structured `git.clone.failed` entry to the backend's stderr, including the
exit status or signal and credential-redacted Git diagnostics. Inspect it with
`podman logs --tail 100 -f images_main_1`. Capture is limited to 64 KiB of text; larger output is
omitted rather than risk logging a partially captured credential. The registration page shows an
actionable reason for common access, network, certificate and storage failures, or the redacted
Git diagnostic for an unrecognised failure.

## `cerebro-agent`

The runner and the Claude CLI it drives, with `git` and `gh`; one container per agent run
(architecture §5). It runs as user 1000 with the checkout at `/work` and the CLI state at
`/cli-state`. The MVP drives Claude only, so the image carries no Copilot CLI.

```sh
podman build -f images/agent.Containerfile -t cerebro-agent .
```

The supervisor starts it with `CEREBRA_GATEWAY_URL` (the backend's `/runner` endpoint) and
`CEREBRA_RUN_TOKEN` (the run's token); the runner connects, receives `start`, and exits 0 when
the run completed or was stopped, 1 otherwise. The `start` message names the backend's `/mcp`
endpoint as the agent's `cerebra` MCP server, with the same token as its bearer.

## `podman-compose.yml`

The main container runs agents only when `CEREBRA_PODMAN_SOCKET` names the mounted Podman socket
and the mounted master key lets it read credentials; otherwise starting an agent answers that
Cerebra can't run agents yet. The other settings, with the values compose gives them:

| Variable                   | Value                   | What it is                                                      |
| -------------------------- | ----------------------- | --------------------------------------------------------------- |
| `CEREBRA_DATA_VOLUME`      | `cerebra-data`          | The volume mounted at `/data`; agent mounts are subpaths of it. |
| `CEREBRA_INTERNAL_NETWORK` | `cerebro-internal`      | Joins the main container and agents only.                       |
| `CEREBRA_EGRESS_NETWORK`   | `cerebro-egress`        | Agents' way out; `./cerebra start` creates it.                  |
| `CEREBRA_GATEWAY_URL`      | `ws://main:4317/runner` | Where a runner reaches the backend.                             |
| `CEREBRA_MCP_URL`          | `http://main:4317/mcp`  | Where an agent reaches its board tools.                         |

Postgres sits on a separate `database` network, so agents cannot reach it. The data volume is
named `cerebra-data` exactly, because the engine mounts it by that name; an instance created before
it was named keeps its data in `images_cerebra-data` — copy it across once with
`podman run --rm -v images_cerebra-data:/from -v cerebra-data:/to docker.io/library/alpine cp -a /from/. /to/`
before starting.
