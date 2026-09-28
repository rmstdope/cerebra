# CLAUDE.md

Guidance for every agent and person working in this repository.

## The project

The next generation of Cerebro: a backend in a rootless container that runs a fleet of AI coding
agents, each in a rootless container of its own, against a project's GitHub repository, and a web UI
through which one person, the navigator, triages the work, agrees what it should achieve and what a
person will see, and talks to every agent as a structured chat. Written in TypeScript on Node, with
Postgres as the one system of record. "Working" means a work item goes from filed to merged through
the lifecycle of `docs/spec.md` §4, with the navigator only on the board and in the chat.

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
- Prefer the simple design; say so when you decline a more general one.

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
