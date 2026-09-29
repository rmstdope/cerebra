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
