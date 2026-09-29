# cerebra

An agent fleet management system: the next generation of
[Cerebro](https://github.com/rmstdope/cerebro).

Cerebro runs a fleet of AI coding agents — Claude Code and GitHub Copilot — against a project's
GitHub repository, and puts one person, the navigator, in charge of it through a web UI. Every work
item is in exactly one state of one fixed lifecycle (triage, grooming, design, build, review, merge,
verify); every agent run is a rootless container holding only what its role needs; and every agent
is shown as a structured chat the navigator can talk into.

**Status:** the local UI and backend are available to try. The full autonomous fleet workflow is
still under development.

## Development

Use Node `v26.9.0`, pinned in [`.nvmrc`](.nvmrc), and pnpm `11.24.0`:

```bash
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` runs linting, formatting checks, strict TypeScript checking, package builds, and
Vitest tests across the workspace. It is the same command CI runs on Ubuntu.

Database tests are part of this gate. With rootless Podman installed and running, `pnpm run check`
automatically starts an isolated disposable PostgreSQL container, waits for it, and removes only
that container after the tests finish. Each gate run owns a uniquely named container, so concurrent
producer worktrees do not interfere with one another. The tests create and drop isolated schemas
in that database, then run the Kysely migrations against each schema.

To use an existing reachable disposable database instead, set `DATABASE_URL` before running the
gate. The command treats that database as caller-owned: it neither creates nor removes it. This is
how CI continues to use its PostgreSQL service container:

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/cerebra_test
pnpm run check
```

Podman startup, database-readiness, connection, and migration failures make the gate fail rather
than skipping database behaviour. The generated connection details are never printed or written
to the checkout.

The workspace packages are:

- `packages/shared` — shared protocol, schema, API-type, and lifecycle foundations.
- `packages/backend` — the Fastify and Postgres service.
- `packages/runner` — the agent runtime protocol adapter.
- `packages/ui` — the React/Vite web interface.

## Local instance

Cerebra runs as a rootless Podman pod. The launcher uses `podman compose`, which requires a
separately installed Compose provider. Docker and Docker Desktop are not required: use
`podman-compose` with Podman as the container engine.

On macOS with Homebrew, install Podman and its Compose provider, then create/start the machine
before the first launch (skip `podman machine init` if you already have a machine):

```bash
brew install podman podman-compose openssl
podman machine init
podman machine start
export PODMAN_COMPOSE_PROVIDER=podman-compose
printf 'POSTGRES_PASSWORD=choose-a-long-local-password\n' > .env
./cerebra start
```

The export explicitly selects `podman-compose` for `start`, `status`, and `update` in the current
shell. Add it to your shell configuration (for example, `~/.zshrc`) to keep that selection in new
terminals.

If startup reports `looking up compose provider failed` and lists missing `docker-compose`
executables, Podman is searching for a provider, not requiring the Docker engine. Install and
select the Podman provider, then retry:

```bash
brew install podman-compose
export PODMAN_COMPOSE_PROVIDER=podman-compose
./cerebra start
```

The application is published only at `http://localhost:4317`; Postgres has no host port. The named
`cerebra-data` and `cerebra-postgres` volumes retain application data and database records across
container restarts. Startup waits for Postgres to accept connections before starting the backend.
The main container has outbound access to GitHub, with Git and CA certificates installed; Postgres
stays on a private network with no published port.

On the first start, the launcher uses OpenSSL to generate a random encryption master key directly
into the external Podman secret `cerebra-project-token-key`. The backend reads its mounted file at
startup; the key is not put in `.env`, the checkout, container environment, or application logs.
Starts and updates reuse that same secret, including after a failed build. Keep it with your
instance: losing it makes stored credentials and project tokens unrecoverable. Include the master
key in your secure, separately protected backup procedure before deleting a Podman machine or
restoring database dumps. Do not delete or replace the secret to troubleshoot startup.

For an older installation that already encrypted values using `CEREBRA_PROJECT_TOKEN_KEY`, import
that **same** key into the named Podman secret before updating (supply it over standard input to
`podman secret create cerebra-project-token-key -` from your secure secret store, never as a command
argument or checkout file). The launcher refuses to generate a replacement if encrypted records
already exist, or if it cannot check the database. An older installation with no encrypted records
can use `./cerebra start` directly. Direct, non-Compose backend development still accepts the legacy
environment variable; never configure it together with `CEREBRA_PROJECT_TOKEN_KEY_FILE`.

Startup reports ready only after the backend health endpoint responds.
Check the pod and its master-key availability with `./cerebra status`. If the browser cannot connect, check whether the `main`
container has exited and read its startup error:

```bash
podman compose --file images/podman-compose.yml logs --tail 50 main
```

When ready to update, run `./cerebra update`. It rebuilds and restarts the pod. Running work stops
and is returned to its queue by the backend; persisted data remains safe in the named volumes. A
failed start or update reports the Podman failure directly so it can be corrected before retrying.

Open `http://localhost:4317`, choose your local password if prompted, and use **Add project** with a
GitHub repository URL and a project GitHub token that can access that repository. The token is
encrypted before storage. An invalid token reports an access error rather than an unavailable
registration service. Register only repositories you intend this instance to manage.

Use the **Project** picker to open a registered project's board or fleet, or choose **Add project**
to register another repository. The list comes from Postgres, so projects remain available even
if browser storage is cleared. Cerebra remembers the selection when registration succeeds or you
select a project; returning visits keep the cross-project navigator queue visible. A failed
project-list request shows an error and retry control, not onboarding.

### Backups

Cerebra dumps its database every night at 02:00 into a folder on your computer, outside Podman's
storage, so a deleted Podman machine does not take your records with it. By default the folder is
`backups/` in this checkout; the launcher creates it and it is ignored by Git. The newest seven
backups are kept and older ones are removed. **Settings → Backups** shows when the next one runs,
the recent ones, and a **Back up now** button. A backup that fails appears in the navigator queue,
with its reason, until a later one succeeds.

Change the defaults in `.env`, then run `./cerebra update`. `CEREBRA_BACKUP_DIR` is the folder
(relative paths are from this checkout), `CEREBRA_BACKUP_TIME` the 24-hour time of the nightly
backup, `CEREBRA_BACKUP_KEEP` how many successful backups to keep, and `CEREBRA_TIMEZONE` the zone
the time is read in, which defaults to your computer's:

```bash
CEREBRA_BACKUP_DIR=~/cerebra-backups
CEREBRA_BACKUP_TIME=03:30
CEREBRA_BACKUP_KEEP=14
CEREBRA_TIMEZONE=Europe/Stockholm
```

A backup that was due while Cerebra was stopped runs once when it starts again. Each backup is a
`pg_dump` custom-format file named `cerebra-<UTC time>-<number>.dump`. A dump holds stored
credentials and project tokens only in encrypted form, so restoring it needs the master key of the
instance that wrote it: keep that key with your backups, and on a fresh Podman machine import it as
described above **before** the first `./cerebra start`. Then stop the backend, restore the dump and
start again:

```bash
podman compose --file images/podman-compose.yml stop main
podman compose --file images/podman-compose.yml exec -T postgres \
  pg_restore --clean --if-exists --no-owner -U cerebra -d cerebra < backups/cerebra-….dump
./cerebra start
```

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
