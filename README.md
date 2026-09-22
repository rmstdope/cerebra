# Cerebra

A self-hosted software-delivery harness for humans and agent fleets, expanding
the [Cerebro](https://github.com/rmstdope/cerebro) experiment to multiple human
roles and independently operating machines.

Each machine runs its own engine and web UI. Engines share a Beads backlog backed
by one Dolt server, claim work exclusively, and execute real Claude Code or
GitHub Copilot CLI sessions inside isolated Docker containers. Humans own UX,
priority, and deployment decisions; project policy controls other involvement.

## First-release implementation

- Human-ranked work, agent decomposition, task-specific worktrees, and independent
  review recorded on GitHub.
- Local fleet dashboard, role-based human inbox, structured streaming chat, and
  browser terminals for the same provider session.
- Persistent machine ownership, bounded recovery, explicit lost-machine
  reassignment, and human waits that retain their agent slots.
- GitHub issue intake, configurable merge gates, human feature verification,
  and human-triggered GitHub Actions deployment.
- Local accounts shared across instances and manually configured agent fleets.

**Release status:** the application and deterministic workflows are implemented;
real shared-store, cross-OS coordination, browser, and container plumbing have
been exercised. Authenticated provider dual-interface sessions, a real consumer
deployment, and 20 simultaneous real-model executions remain live-environment
acceptance gates. See the [implementation evidence and assumptions](docs/implementation-notes.md).

## Getting started

Requires Node.js 22+, pnpm, Docker, Git, gh, Beads with guarded updates, and a
shared Dolt server. Provider subscription logins are provisioned into dedicated
agent homes, never extracted from the host.

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js help
```

Follow the [operator guide](docs/operator-guide.md) to build the agent image,
configure shared storage, create accounts, authenticate agents, and start each
instance. Start from [the example configuration](examples/cerebra.config.json).

## Design and development

The [product definition and architecture baseline](docs/product-and-architecture.md)
records the interview and approved stack: TypeScript/Node.js, React/Vite,
Fastify, xterm.js, Docker, Beads/Dolt, pnpm, Vitest, and Playwright.

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
```

Automatic scaling, Teams/Slack/email interaction, enterprise access controls,
cloud workers, and production monitoring are later capabilities. The initial
release reports operational bottlenecks but does not automatically resize fleets.
