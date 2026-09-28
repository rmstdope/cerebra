# cerebra

An agent fleet management system: the next generation of
[Cerebro](https://github.com/rmstdope/cerebro).

Cerebro runs a fleet of AI coding agents — Claude Code and GitHub Copilot — against a project's
GitHub repository, and puts one person, the navigator, in charge of it through a web UI. Every work
item is in exactly one state of one fixed lifecycle (triage, grooming, design, build, review, merge,
verify); every agent run is a rootless container holding only what its role needs; and every agent
is shown as a structured chat the navigator can talk into.

**Status:** designed, not yet built. The documents are the whole of it so far.

## Documents

Read them in this order:

1. [`docs/background.md`](docs/background.md) — what this replaces, what it keeps, and what was
   learnt on the way. Start here without context.
2. [`docs/spec.md`](docs/spec.md) — what the system does.
3. [`docs/architecture.md`](docs/architecture.md) — how it is built.
4. [`docs/decisions.md`](docs/decisions.md) — every design decision and why, and what is still
   open.
5. [`docs/roadmap.md`](docs/roadmap.md) — how it gets built, step by step, starting with the MVP.

Until the MVP runs its own development, this repository is built by classic Cerebro's fleet
(`docs/roadmap.md`).
