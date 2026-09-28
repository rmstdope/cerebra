# cerebra

An agent fleet management system: the next generation of
[Cerebro](https://github.com/rmstdope/cerebro).

Cerebro runs a fleet of AI coding agents — Claude Code and GitHub Copilot — against a project's
GitHub repository, and puts one person, the navigator, in charge of it through a web UI. Every work
item is in exactly one state of one fixed lifecycle (triage, grooming, design, build, review, merge,
verify); every agent run is a rootless container holding only what its role needs; and every agent
is shown as a structured chat the navigator can talk into.

**Status:** designed, not yet built. The documents are the whole of it so far.

## Development

Use Node `v26.9.0`, pinned in [`.nvmrc`](.nvmrc), and pnpm `11.24.0`:

```bash
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` runs linting, formatting checks, strict TypeScript checking, package builds, and
Vitest tests across the workspace. It is the same command CI runs on Ubuntu.

Database tests are part of this gate and require `DATABASE_URL` to point to a reachable,
disposable PostgreSQL database. The tests create and drop isolated schemas in that database, then
run the Kysely migrations against each schema. For example, after starting a local PostgreSQL
server:

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/cerebra_test
pnpm run check
```

`DATABASE_URL` is deliberately required: a missing, unreachable, or migration-failing database
makes the gate fail rather than skipping database behaviour. CI provides the same disposable
PostgreSQL database through its service container.

The workspace packages are:

- `packages/shared` — shared protocol, schema, API-type, and lifecycle foundations.
- `packages/backend` — the Fastify and Postgres service.
- `packages/runner` — the agent runtime protocol adapter.
- `packages/ui` — the React/Vite web interface.

## Local instance

Cerebra runs as a rootless Podman pod. On macOS, install Podman and create/start its machine
before the first launch:

```bash
podman machine init
podman machine start
printf 'POSTGRES_PASSWORD=choose-a-long-local-password\n' > .env
./cerebra start
```

The application is published only at `http://localhost:4317`; Postgres has no host port. The named
`cerebra-data` and `cerebra-postgres` volumes retain application data and database records across
container restarts. Check the pod with `./cerebra status`.

When ready to update, run `./cerebra update`. It rebuilds and restarts the pod. Running work stops
and is returned to its queue by the backend; persisted data remains safe in the named volumes. A
failed start or update reports the Podman failure directly so it can be corrected before retrying.

[`images/`](images/) is reserved for Containerfiles and [`spikes/`](spikes/) for throwaway
experiments.

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
