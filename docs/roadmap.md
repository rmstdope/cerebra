# Roadmap

How this repository gets from documents to a system that builds itself. Each step says what it
produces and how to tell it is done. The MVP's scope is `spec.md` §14; the reasons are
`decisions.md`.

## How the work is run until the MVP exists

The MVP is built by **classic Cerebro's fleet**, mounted in this repository (D43): its producers
plan, build test-first, review and merge each piece of work; the navigator ranks it and agrees
every user experience with its UX agent. Work is tracked on classic Cerebro's beads board for this
repository, with a prefix of its own chosen at step 1 (not `cb`, which is classic Cerebro's). That board and the submodule are scaffolding: the last
step moves the work onto this system and removes both.

## Working from these documents

- **Every bead cites the sections it implements** (`spec.md §4.4`, `architecture.md §5.2`, D*n*),
  so a producer with no context knows what to read.
- **The documents are the contract.** A change that contradicts one changes the document in the
  same pull request, and a change to a decision edits its entry in `decisions.md` and says so.
  Never leave a document describing what the code no longer does.
- **What the documents leave to the implementation is the producer's**, decided in its plan: exact
  field names, module boundaries inside a package, library choices below the ones step 2 settles.
- **A question the documents do not answer, and that the producer cannot decide alone** (anything
  a person sees, anything that changes the lifecycle or a boundary), goes to the navigator.

## Step 0 — The documents (done)

`spec.md`, `architecture.md`, `decisions.md`, `background.md` and this file, moved here from classic
Cerebro's repository where they were written.

## Step 1 — Mount classic Cerebro and define the project

From this repository's root, following classic Cerebro's `README.md`:

```bash
git submodule add https://github.com/rmstdope/cerebro.git .cerebro/cerebro
git submodule update --init --recursive
.cerebro/cerebro/scripts/install
```

Then start a fleet CLI session here and run `/project-definition`. It will find `docs/` and this
repository's `CLAUDE.md` and ask whether to continue around what is here: answer *continue*. Its
interview asks what the software is, where it runs, what it is built with and what using it is
like; every answer is in `spec.md` and `architecture.md`, so point it at them. It merges its
sections into `CLAUDE.md`, keeping ours. Its epics are steps 2 to 9 below, each with the children
listed there.

**Done when** the board holds the epics of steps 2–9, ranked, and classic Cerebro's fleet view runs
in this repository.

## Step 2 — Foundations

One epic implementing the foundation choices confirmed during project definition on 2026-09-28
(D44, D45). Exact versions and remaining implementation choices are recorded as they are made:

- **Repository layout:** one pnpm workspace — `packages/shared` (the runner protocol, the event
  schema, the API types, the lifecycle table), `packages/backend`, `packages/runner`,
  `packages/ui` — plus `images/` for the Containerfiles and `spikes/` for throwaway code.
- **Node version:** the current LTS, pinned in `.nvmrc` and `engines`.
- **Backend HTTP:** Fastify, with its WebSocket plugin.
- **Postgres access and migrations:** Kysely with its migrator (typed SQL, no ORM).
- **UI:** React with Vite, shadcn/ui with Radix primitives and Tailwind CSS. The first application
  UI includes Light/Dark/System themes and WCAG 2.2 AA accessibility (D45).
- **Tests:** Vitest everywhere; database tests against a real Postgres (a service container in CI);
  end-to-end tests against real Podman (step 7: `pnpm run test:e2e`, CI's `e2e` job, D44).
- **Lint and format:** ESLint and Prettier; TypeScript `strict`.
- **CI and gate:** GitHub Actions on `ubuntu-latest`: `pnpm run check` covers lint, format checks,
  typecheck, build, unit and database tests on every pull request. Both declared gates use that
  command, exactly as CI does. Installation is `pnpm install --frozen-lockfile`; foundations
  documents the real-Postgres prerequisite and implements these currently absent commands.
  Worktree preparation skips installation until the first producer creates the manifest and
  lockfile; `install` stays undeclared so the harness detects the frozen pnpm install thereafter.
- **Confirmed decisions:** D16 (a runner over the vendors' SDKs, subject to step 3's spike) and
  D25 (rework continues the same pull request).

**Done when** the workspace builds, an empty test passes in each package, CI is green on `main`, and
the decisions are recorded.

## Step 3 — Spike the agent runtime

Throwaway code under `spikes/`, to prove or disprove what the whole agent runtime rests on before
any of it is built. On the navigator's Mac, under rootless Podman:

1. A container from a minimal image with Node, the Claude CLI and the Claude Agent SDK, given
   `CLAUDE_CODE_OAUTH_TOKEN` as its only credential, runs an agent that calls `AskUserQuestion`.
2. `canUseTool` delivers the question to a program **outside** the container, over a network the
   two share (standing in for the main container on `cerebro-internal`); the program answers; the
   agent continues with the answer.
3. A message sent mid-turn through streaming input reaches the agent.
4. The container is removed, a new one started with the same CLI state directory mounted, and the
   conversation resumes by session id.
5. An MCP server outside the container, reached over the same network with a bearer token, is
   callable by the agent.

**Done when** each of the five is shown working, or shown not to, and the findings are written into
`decisions.md`: D16 and D20 confirmed, or revised with what replaces them. Nothing in `spikes/` is
built on.

## Steps 4–8 — The MVP

The order of `spec.md` §14. Each step is an epic; its children are the obvious pieces, and the
fleet splits them further as it plans.

**Step 4 — The pod and the board.** The main container and Postgres as a pod under rootless Podman;
login for the one user; projects (register from a GitHub URL, clone the mirror); work items with the
lifecycle engine (the transition table as data, the pure function, the database constraints, tested
over every state, transition and actor); the board and item views, triage and quick-add; the
navigator's queue. Agents do not exist yet: only the navigator moves items.
*Done when* the navigator can file, triage and move items by hand through every queue and navigator
state the MVP has (working states need a run and arrive in step 5; `split` and the verify stage are
v1); the engine's tests cover every transition of spec §4.4, working states included, against fake
runs; and every single-row invariant is refused by the database when broken.

**Step 5 — Runs and the chat.** Agent types seeded from files, with the plain edit form; named
agents created at registration (spec §5.2) and the fleet page; the engine interface (Podman, and a
fake); the agent image with the runner and the `claude` adapter; the runner protocol and the event
schema; the supervisor; the chat view with questions as forms and messages mid-run; secrets at
instance and project scope. The navigator starts the assistant by hand from the fleet page and
talks to it.
*Done when* a conversation with the assistant works end to end in the browser, including a question
answered through a form and a message sent mid-turn.

**Step 6 — Agents at work.** The agents' tools over MCP; per-run checkouts; each named agent's
memory (its home and CLI state kept across runs); the dispatcher and state triggers with limits; the groomer and the outcome record.
*Done when* an item triaged to `grooming_ready` starts a groomer by itself, the groomer and the
navigator agree its outcome in the chat, and the item leaves grooming on the route the navigator
confirmed.

**Step 7 — Building, reviewing, merging.** The producer and the bugfixer (plan record, push, pull
request with the `Work-Item:` trailer); the reviewer and the review record; rounds and attempts;
merge by rule on green checks; the `plan` and `code_review` checkpoints; usage and cost per run and
per item; browser notifications; the scheduled database dump; an end-to-end test with a stub agent
image under real Podman in CI.
*Done when* an item in `build_ready` is built, reviewed, sent back once, fixed and merged with no one
starting anything, and, with the project set to `full`, the next item stops at the plan and at the
code review (in the MVP `full` means those two; `informed` is v1).

**Step 8 — Design.** The designer, `show_mockups`, sandboxed mockup serving, the design record.
*Done when* an item goes from `new` through grooming and design to merged, with the navigator only
in the chat and on the board.

## Step 9 — Handover

This system takes over its own development: this repository is registered as a project in a running
instance, its open beads are re-filed as work items (by hand, or by the importer if it has been
pulled forward from v1), the classic fleet is stopped, and the submodule, its declarations and the
beads board are removed from this repository.

*Done when* the next piece of work on this repository is groomed, designed, built, reviewed and
merged by this system.

## After the MVP — v1

Everything `spec.md` §14 postpones, in an order the navigator ranks once the MVP is in use: the
Copilot backend; the verify stage and the verifier; nesting and splitting; schedules with the
architect and the inbox; releases and release records; instance skills; revisions of agent types;
the board mirror branch and restore; the cost views; the webhook, the feed and the remaining
checkpoints; project images from a Containerfile; surviving a backend restart; the beads importer.
