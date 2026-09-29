# Images

Containerfiles for Cerebra's two images (architecture §12). Build both from the repository root.

## `cerebro-main`

The backend and the web UI.

```sh
podman build -f images/main.Containerfile -t cerebro-main .
```

## `cerebro-agent`

The runner and the Claude CLI it drives, with `git` and `gh`; one container per agent run
(architecture §5). It runs as user 1000 with the checkout at `/work` and the CLI state at
`/cli-state`. The MVP drives Claude only, so the image carries no Copilot CLI.

```sh
podman build -f images/agent.Containerfile -t cerebro-agent .
```

The supervisor starts it with `CEREBRA_GATEWAY_URL` (the backend's `/runner` endpoint) and
`CEREBRA_RUN_TOKEN` (the run's token); the runner connects, receives `start`, and exits 0 when
the run completed or was stopped, 1 otherwise.

## `podman-compose.yml`

The main container runs agents only when `CEREBRA_PODMAN_SOCKET` names the mounted Podman socket
and `CEREBRA_PROJECT_TOKEN_KEY` lets it read credentials; otherwise starting an agent answers that
Cerebra can't run agents yet. The other settings, with the values compose gives them:

| Variable                   | Value                   | What it is                                                      |
| -------------------------- | ----------------------- | --------------------------------------------------------------- |
| `CEREBRA_DATA_VOLUME`      | `cerebra-data`          | The volume mounted at `/data`; agent mounts are subpaths of it. |
| `CEREBRA_INTERNAL_NETWORK` | `cerebro-internal`      | Joins the main container and agents only.                       |
| `CEREBRA_EGRESS_NETWORK`   | `cerebro-egress`        | Agents' way out; `./cerebra start` creates it.                  |
| `CEREBRA_GATEWAY_URL`      | `ws://main:4317/runner` | Where a runner reaches the backend.                             |

Postgres sits on a separate `database` network, so agents cannot reach it. The data volume is
named `cerebra-data` exactly, because the engine mounts it by that name; an instance created before
it was named keeps its data in `images_cerebra-data` — copy it across once with
`podman run --rm -v images_cerebra-data:/from -v cerebra-data:/to docker.io/library/alpine cp -a /from/. /to/`
before starting.
