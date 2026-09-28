# Background

Read this first if you have no context. It explains what this repository replaces, what it keeps
from its predecessor, and what was found out about the agent SDKs while the design was written. The
design itself is `spec.md` (what) and `architecture.md` (how); the reasons are `decisions.md`; the
order of work is `roadmap.md`.

## Classic Cerebro

This repository is **Cerebra**, the next generation of Cerebro. These documents call its predecessor
**classic Cerebro**: the repository `github.com/rmstdope/cerebro`, still in use, and the fleet that
builds this one until it can build itself (D43). "MVP" and "v1" always mean releases of *this*
system, never of classic Cerebro.

Classic Cerebro is a harness a project mounts as a git submodule at `.cerebro/cerebro`:

- **Agents** are Claude Code or Copilot CLI sessions, each started with a role definition
  (`agents/<role>.md`) and usually a skill (`skills/<skill>/SKILL.md`), running on the navigator's
  machine in git worktrees of the project, with no container between them and the host.
- **Work** is tracked in **beads** (`bd`), an issue tracker stored in a Dolt database and synced
  through a Dolt remote. A bead's place in the pipeline is spread over its status, its priority, its
  assignee and some fifteen routing labels (`ux:agreed`, `ux:none`, `planned`, `human`,
  `needs-ui-decision`, `pause:kept`, `second-look`, `plan:revise`, `verification:failed`, …), read
  by bash scripts that decide which role may take it.
- **The fleet view** (`cerebro-tui`, Rust) is a terminal program that hosts every session in a
  pseudo-terminal, shows the fleet and the board, and starts, ends and nudges sessions. Each agent
  reports its status through a JSON state file it writes with a script.
- **Declarations** are files under the project's `.cerebro/`: `project.conf` (settings,
  `navigator_gates`), `roster.conf` (which named agents run), `agents.conf` (model and CLI per
  agent), `traps.md` (pitfalls the project has paid for).

Its named agents, and the role each plays here:

| Classic agent | Classic role | Here | Port its instructions from |
|---|---|---|---|
| Cerebro | orchestrator | assistant | `agents/orchestrator.md`, `skills/write-bead` |
| Xavier, Beast | ux | designer | `agents/ux.md`, `skills/agree-experience` |
| Cyclops, Storm, Wolverine, Rogue | producer | producer | `agents/producer.md`, `skills/produce-bead` |
| Bishop | bugfixer | bugfixer | `agents/bugfixer.md`, `skills/fix-bug` |
| (a sub-agent of each producer) | review | reviewer | `agents/reviewer.md` (its sub-agent mode) |
| Psylocke | verifier | verifier (v1) | `agents/verifier.md` |
| Moira | user-feedback | inbox (v1) | `agents/user-feedback.md` |
| Forge | architect | architect (v1) | `agents/architect.md` |
| Cypher | external pull-request reviewer | dropped (D24) | — |
| — | — | groomer (new, D34) | nothing to port; `skills/write-bead`'s interview is the nearest |

`docs/agent-workflow.md` in classic Cerebro is its operating guide and records the behaviour each
role was tuned against. Read it before writing a role's instructions here; keep what it learnt about
*how the role talks to the navigator and decides*, and drop everything about labels, state files,
scripts, worktrees and the terminal.

### Why it is being replaced

The navigator's reasons, which the design answers one by one:

- **A work item's state is ambiguous** — several fields and labels together say where a bead is.
  Here: one `state` field, one fixed lifecycle (D6, D7).
- **Agents run unconfined on the host.** Here: one rootless container per run, holding only what
  its role needs (D3).
- **The navigator sees agents through a terminal.** Here: a web UI with a structured chat per run
  (D4, D9).
- **The fleet is a static roster.** Here: agent types defined per instance, overridden per project,
  started by work reaching a state or by a schedule (D27, spec §5).
- **Agents reach external systems with whatever the host has.** Here: scoped secrets (spec §7).

### What carries over

- The **roles** and the **stages** a piece of work passes through, with grooming added before
  design (D34) and review made its own stage (D8).
- **Named agents** with a memory (D17).
- The rules the roles were built on: nothing merges red or with unresolved review findings; agents
  never decide the shape of what a person sees — the designer settles it with the navigator, and a
  builder decides only inside it, writing down what it decided; closed is not terminal, and a
  failed verification reopens at P0; the architect files, never fixes.
- The **record headings** of each stage (spec §4.11), tuned in classic Cerebro's `agree-experience`
  and `produce-bead` skills.

### Classic terms, and what they are here

| Classic Cerebro | Here |
|---|---|
| bead | work item |
| `bd` board, Dolt remote | the `items` table in Postgres; the `cerebro/board` branch (v1) |
| routing label | a state (spec §4.2); labels here never route |
| `human` / `needs-ui-decision` / `pause:kept` | `waiting`, with a reason |
| `ux:agreed` | `build_ready` after `designing` |
| `ux:none` | routed past design at triage or grooming |
| `planned`, the `design` field | the plan record |
| the `acceptance` field | the design record |
| `producer-park`, `reopen-failed` | transitions (spec §4.4) |
| state file (`idle`/`working`/`asking`/`waiting`) | run status (spec §6.1) |
| fleet view, `cerebro-tui` | the web UI |
| `roster.conf`, `agents.conf` | agents and agent types (spec §5) |
| `navigator_gates` | involvement checkpoints (spec §4.9) |
| `traps.md` | project instructions (spec §3) |
| epic | a parent item in `split` (v1) |

## What was found out about the agent SDKs

Researched on 2026-09-28; re-check anything load-bearing before building on it (`roadmap.md`,
step 3, exists to do that).

**Claude.** The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, TypeScript; also Python) runs
Claude Code as a library. Streaming input gives a long-lived, bidirectional session; messages can be
sent mid-turn. The `canUseTool` callback receives every tool call not pre-approved, including
`AskUserQuestion`, whose `questions` the host shows and whose answers it returns in the callback's
result — this is how an agent's question reaches the chat. Hooks (`PreToolUse`, `PostToolUse`, …),
MCP servers (`mcpServers`), a system-prompt append, sub-agents (messages carry
`parent_tool_use_id`) and resume by session id are all options. `total_cost_usd` and token usage are
reported per result. Authentication: `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` from
`claude setup-token` (a subscription); bare mode ignores the OAuth token. The documentation bars
third-party *products* from offering claude.ai login; D20 records the navigator's choice.
`CLAUDE_CONFIG_DIR` relocates the CLI's state (sessions, memory).

**Copilot.** The GitHub Copilot SDK (`github/copilot-sdk`; TypeScript, Python, Go, .NET, Java, Rust;
generally available) speaks JSON-RPC to the Copilot CLI in server mode, which it can spawn or attach
to. It offers sessions (`createSession`, `resumeSession`), `send` mid-run, events
(`assistant.message`, `assistant.message_delta`, `tool.execution_start`,
`tool.execution_complete`, `session.idle`, `session.error`, …), `onPermissionRequest`,
`onUserInputRequest` and elicitation forms for questions to the human, custom tools, MCP servers,
custom agents and a system-message append. The CLI (`copilot`) also has `-p`, `--allow-all-tools`,
`--output-format json` (no documented schema), `--resume`, `--additional-mcp-config`, `--agent`,
`--model`. Authentication: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN`, holding an OAuth
token or a fine-grained personal PAT with the "Copilot Requests" permission (classic PATs are
refused), billed to that seat. Unverified: whether the CLI discovers skills as Claude does, and the
exact field reporting premium requests.

**ACP** (Agent Client Protocol) is spoken by both — `copilot --acp` natively (public preview),
Claude through the `@agentclientprotocol/claude-agent-acp` adapter — and was rejected as the common
protocol (D16): both sides are preview-grade, it assumes an editor on the other end of stdio, and a
free-form question to the human is not clearly part of it.
