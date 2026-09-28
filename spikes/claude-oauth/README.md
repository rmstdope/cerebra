# Claude OAuth rootless spike

This disposable experiment tests the first capability in roadmap step 3: a real Claude Agent SDK
session in a rootless Podman container, authenticated only with a Claude subscription token, can
call `AskUserQuestion` and receive the host's answer.

## Prerequisites

- Rootless Podman must be installed and running.
- Node is needed only to run the local static test.
- The shell running the command must have `CLAUDE_CODE_OAUTH_TOKEN` set from `claude setup-token`.

Do not put the token in a file, command argument, image layer, commit, or captured transcript. The
wrapper checks only that the environment variable is non-empty, and asks Podman to forward it by
name.

## Run

From this directory:

```bash
node --test src/permission.node.mjs
./run-rootless.sh
```

The script builds a Node image containing the Claude CLI and Agent SDK, then starts it as the
unprivileged `node` user with a read-only root filesystem, no capabilities, `no-new-privileges`,
and temporary writable directories for the CLI state. It uses the Agent SDK's default mode; it
does not enable bare mode because bare mode ignores `CLAUDE_CODE_OAUTH_TOKEN`.

A successful run prints these two markers, in order:

```text
ASK_USER_QUESTION_RECEIVED
SPIKE_COMPLETE
```

The marker text is the only intended evidence from the container. The runner deliberately does
not print model messages, SDK errors, or environment values, which could accidentally disclose a
secret.

## Cleanup

The container is removed automatically. To remove the locally built disposable image:

```bash
podman image rm localhost/cerebra-claude-oauth-spike:latest
```
