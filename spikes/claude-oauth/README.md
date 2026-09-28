# Claude OAuth rootless spike

This disposable experiment tests the first two capabilities in roadmap step 3: a real Claude Agent
SDK session in a rootless Podman container, authenticated only with a Claude subscription token,
can call `AskUserQuestion`; and its `canUseTool` callback can relay that actual question to a
separate program over a shared network and return the program's answer to the agent.

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

The script builds a Node image containing the Claude CLI and Agent SDK, creates a disposable
rootless Podman network, and starts a question-relay container on it. The agent container sends
the tool's `questions` array to that relay at `http://question-relay:8080/question`; the relay
returns its answer, which `canUseTool` supplies to the SDK. The relay has no OAuth token. Both
containers run as the unprivileged `node` user with a read-only root filesystem, no capabilities
and `no-new-privileges`; the agent alone receives temporary writable directories for CLI state.
The SDK remains in default mode because bare mode ignores `CLAUDE_CODE_OAUTH_TOKEN`.

A successful run prints these three markers, in order:

```text
RELAY_RECEIVED_QUESTION
ASK_USER_QUESTION_RECEIVED
SPIKE_COMPLETE
```

The relay receipt shows that a program outside the agent container received the actual question;
the two following markers show that the callback returned its answer and the agent completed its
turn. The marker text is the only intended evidence from either container. Neither program prints
model messages, SDK errors, question contents, or environment values, which could accidentally
disclose a secret.

## Cleanup

The container is removed automatically. To remove the locally built disposable image:

```bash
podman image rm localhost/cerebra-claude-oauth-spike:latest
```
