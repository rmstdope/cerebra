# CLAUDE.md

Guidance for every agent and person working in this repository.

## The project

Cerebra is a web application through which one navigator runs a fleet of AI coding agents across
multiple GitHub repositories. The navigator ranks work, agrees outcomes and user experiences in
structured chats, and answers approvals; agents build, independently review and merge. Every work
item has one lifecycle state, and everything needing the navigator appears in one queue. Written
in TypeScript on Node, with Postgres as the one system of record. The Claude-only MVP is working
when this repository's own work goes from filed to merged through `docs/spec.md` §4, with the
navigator only on the board and in the chat. Classic Cerebro builds it until handover; Copilot,
multiple users and the other deferred features are outside the MVP.

The navigator manually installs and updates the local instance when convenient. The backend and
Postgres run as a pod under rootless Podman, through a Podman machine VM on macOS; every agent run
has a separate rootless container. The localhost web UI requires a password. Postgres and
persistent volumes retain records and agent state, with scheduled database dumps to a mounted
directory. An MVP backend restart fails live runs and returns their work to its queues.
Uninterrupted recovery and server deployment are later work.

First use means choosing a password, registering a GitHub repository and configuring credentials,
then reaching an honest empty board with a clear way to file work. Returning visits open the
cross-project navigator queue. Errors are explicit; history, cancellation, reopening and reasoned
overrides support correcting mistakes. The web UI must feel **Modern, Stylish, Easy**: simple to
navigate and operate, with powerful controls available when needed. React/Vite uses shadcn/ui,
Radix primitives and Tailwind CSS. Light and dark themes ship from the first application UI,
defaulting to the system preference with a persistent Light/Dark/System choice. Accessibility
targets WCAG 2.2 AA, keyboard access, screen-reader labels, visible focus, sufficient contrast and
reduced motion. UX sessions agree detailed screens and wording.

## Where to start

Nothing about this system is obvious from the code yet, so read before you build:

1. `docs/background.md` — the system this replaces (*classic Cerebro*) and why; read it first if you
   have no context.
2. `docs/spec.md` — what the system does. §2 is the glossary; §4 is the lifecycle every other part
   depends on.
3. `docs/architecture.md` — how it is built.
4. `docs/decisions.md` — why each choice was made (D*n*), and what is still open.
5. `docs/roadmap.md` — the steps, what each produces, and how to tell it is done.

A piece of work names the sections it implements; read those, and the decisions they cite, before
planning.

## The documents are the contract

- A change that makes a document untrue updates it in the same pull request.
- A change to a decision edits its entry in `docs/decisions.md` and says so; never contradict a
  decision quietly in code or in another document.
- What the documents leave open is the implementer's to decide, in the plan. What they settle is
  not: the lifecycle, the boundaries between containers, what a person sees.

## Development practices

- Work is delivered in small increments that stand on their own.
- Code is written test-first, and the work continues without pausing for approval between phases
  until it is done and ready to commit.
- Tests assert the behaviour of code. Prose and configuration get no test.
- The gate a producer runs before opening a pull request is exactly what CI runs, on
  `ubuntu-latest`; a test that passes only on macOS is a red pull request.
- Install with `pnpm install --frozen-lockfile`; both gates are `pnpm run check` (lint, format
  checks, typecheck, build, unit and real-Postgres database tests). Foundations implements these
  commands and documents the database prerequisite; they are not runnable in the documents-only
  repository. Step 7 adds real-Podman end-to-end coverage.
- Before the workspace exists, worktree preparation installs nothing: `install` is deliberately
  undeclared. The foundation producer creates the manifest and lockfile and installs dependencies;
  once `pnpm-lock.yaml` exists, the harness detects `pnpm install --frozen-lockfile` automatically.
- Prefer the simple design; say so when you decline a more general one.

## Producer review

Nothing merges red. Before delivery, a producer obtains and addresses one independent, full review
of the complete diff and bead. If its changes are substantial enough to make another review useful,
the producer chooses the right follow-up scope and obtains it; minor, self-contained answers need
not create a review loop. Unresolved findings, a red or missing check, or a reviewer that cannot
produce a usable result go to a person. Whether the navigator also takes part in the plan, the
review or the merge is `navigator_gates` in `.cerebro/project.conf`; absent means none.

## Work tracking

*Read by every role through `skills/beads-workflow`, which carries the commands; this section is
where a project says anything that differs.*

Planned work is tracked in beads. An external issue tracker, if there is one, is the inbox for
outside requests and bug reports only. Every bead is created unranked and ranked later with a human.
The UX is agreed in one session; the producer plans and implements in another, following the
current `produce-bead` workflow. Every bead cites the specification and architecture sections and
decisions it implements. This board is classic Cerebro's scaffolding, removed at roadmap step 9;
the application's own work items live in Postgres.

## Invariants the code must keep

Load-bearing across the system; `docs/architecture.md` explains each.

- **One state per work item**, changed only by the lifecycle module's pure transition function;
  the invariants of spec §4.3 that concern a single row are also database constraints.
- **Agents never write the database.** They reach the board only through the backend's tools, and
  every call is checked against the lifecycle and the calling run's type.
- **The backend never runs git inside a checkout an agent has written to.** It works in its own
  mirror; diffs come from the pull request or from fetching the pushed branch.
- **Only the main container holds the container engine's socket.** Agent containers get no socket,
  no database, and nothing of another run.
- **Secrets are never logged, never returned by the API, and never written into a checkout.**
- **A failed read is never an empty answer**, and the UI never shows a failure as "nothing there".
- **Nothing merges red or with unresolved review findings.**
