# Cerebra: architecture

**Status:** draft 1, 2026-09-28. The behaviour it implements is `spec.md`; the choices behind it
are in `decisions.md`.

## 1. Overview

```
 Browser ──HTTPS──► ┌────────────── pod: cerebro ───────────────┐
                    │  main container                           │
                    │   ├─ web UI (static)                      │
                    │   ├─ API: REST + WebSocket                │       rootless Podman
                    │   ├─ lifecycle engine, dispatcher,        │◄────── API socket
                    │   │  scheduler, run supervisor            │       (bind-mounted)
                    │   ├─ runner gateway  ◄────────┐           │            │
                    │   ├─ MCP server      ◄──────┐ │           │            │ creates
                    │   ├─ git mirror, GitHub client│ │         │            ▼
                    │   └─ secrets                │ │           │   ┌─ agent container ─┐
                    │  postgres container         │ │           │   │ runner            │
                    └─────────────────────────────┼─┼───────────┘   │  └─ SDK ─► CLI    │
                                                  │ └─ network: ────┤ /work (checkout)  │
                                                  └─── internal ────┤ /home             │
                                                                    └─────────┬─────────┘
                                                            network: egress   ▼  model API,
                                                                                 GitHub, registries
```

Three kinds of container:

| Container | Role |
|---|---|
| **main** | The only stateful service besides the database. Serves the UI and API, owns the lifecycle, starts and supervises agent containers, serves the agents' tools, keeps the git mirrors, talks to GitHub, holds the secrets. |
| **postgres** | The system of record (D5). Reachable from the main container only. |
| **agent** | One per run. A runner process drives the agent backend's SDK, which drives its CLI. Unprivileged, no container socket, sees only its own checkout and home. |

## 2. Containers and isolation

**Rootless throughout.** The main container and Postgres run as a pod under the navigator's
rootless Podman. The main container is given the rootless Podman API socket and starts agent
containers as siblings through it (Docker-compatible REST API). Holding that socket gives the main
container everything the navigator's Podman user can do, which makes it the high-value target; it
is also the only container that holds it.

*Rejected:* nested Podman inside the main container. Better containment of the agents, but it
needs `/dev/fuse`, user-namespace mappings inside the container and a storage driver that works
nested, and it fails differently on each host.

**Agent container specification.**

- Runs as a non-root user; root filesystem read-only; `no-new-privileges`; all capabilities dropped.
- Mounts: its checkout at `/work` (read-write), its home at `/home/agent` (read-write), the CLI
  state directory of the named agent it runs as (D17), secrets declared as files on a tmpfs.
- Environment: the run token, the backend addresses, and secrets declared as variables.
- Networks: `cerebro-internal` (declared internal: no gateway) to reach the runner gateway and the
  MCP server, and `cerebro-egress` for the model API, GitHub and package registries. Egress is
  open in v1 (D22); an allow-list would be an egress proxy in the pod, configured from the type's
  `network` field.
- CPU and memory limits from the agent type.
- Never: the container socket, the database, another run's files, the mirror writable.

The `engine` module builds this specification itself from the run and named agent it is given;
a caller supplies only the image, command, environment and resource limits, never a mount, a
network, a user or a privilege. Its mounts are subpaths of the `/data` volume: `runs/<run>/checkout`
at `/work`, `agents/<agent>/home` at `/home/agent` and `agents/<agent>/cli-state` at `/cli-state`,
plus a `/tmp` tmpfs, which a read-only root filesystem needs. It talks to rootless Podman over
the API socket's Docker-compatible endpoints; an engine failure is an error, and only the engine's
own "no such container" reads as a container that is absent.

**Networks.** `cerebro-internal` joins the main container and every agent container and nothing
else. `cerebro-egress` gives the main container and agents outbound access to GitHub and other
external services. Postgres uses a separate private network shared only with main, never the
agent or egress networks. In the local Compose deployment this database network is named
`internal`, and main also joins `egress`. The UI port is published on `127.0.0.1` only
(D1); a server deployment puts a TLS reverse proxy in front of it.

## 3. The main backend

Modules, each one concern:

| Module | Owns |
|---|---|
| `api` | REST and WebSocket endpoints for the UI; authentication. |
| `lifecycle` | The state machine of `spec.md` §4 as data and one pure function (§4 below). |
| `board` | Work items, records, comments, history; every write goes through `lifecycle`. |
| `fleet` | Agent types, their project overrides, named agents. |
| `dispatcher` | Starting runs for state triggers (§6). |
| `scheduler` | Starting runs for schedule triggers (§6). |
| `supervisor` | Run lifecycle: create the container, watch it, stop it, reconcile after a restart (§5.3). |
| `gateway` | The runner protocol endpoint (§5.2). |
| `mcp` | The agents' tools (`spec.md` §6.3), served over MCP. |
| `git` | Mirrors and per-run checkouts (§7). |
| `github` | Pull requests, checks, merges, issues (§8). |
| `secrets` | Storage, resolution and injection (§9). |
| `engine` | The container engine behind one interface, with a fake for tests. |
| `events` | Fan-out of run and board events to the UI. |
| `notify` | Deciding which events push (`spec.md` §4.8), batching them, and delivering them to open browser tabs and the webhook. |

Written in TypeScript on Node (D21), sharing the runner protocol, the event schema and the API
types with the runner and the UI as one workspace package.

The workspace uses pnpm, with `packages/shared`, `packages/backend`, `packages/runner` and
`packages/ui`. The backend uses Fastify with its WebSocket plugin and Kysely with its migrator
for Postgres access (D44).

## 4. The lifecycle engine

The transition table of `spec.md` §4.4 is data: `(from, to, actor role, preconditions, effects)`.
One pure function applies a requested transition to an item and returns the new item and its
effects (counter changes, a comment, a notification), or a refusal naming the rule. REST, MCP, the
dispatcher, the supervisor and the GitHub watcher all call it; nothing else writes `state`.

Every mutation runs in one database transaction that locks the item row, re-reads it, applies the
function and writes the item, its history row and its events. A claim is the same transaction as
the insertion of the run that holds it.

The invariants of `spec.md` §4.3 that concern a single row are also database constraints, so a bug
in the engine is a refused write rather than a corrupt board:

- `state` is an enum;
- `CHECK ((state IN working states) = (holder_run_id IS NOT NULL))`;
- `CHECK ((state = 'waiting') = (waiting_kind IS NOT NULL AND waiting_reason IS NOT NULL AND return_state IS NOT NULL))`;
- `CHECK ((state = 'new' AND priority IS NULL) OR state = 'cancelled' OR (state <> 'new' AND priority IS NOT NULL))`.

That the holder is a *live* run, and that an item with children is `split`, `done` or `cancelled`,
span several rows; the engine checks them inside the same locked transaction, and no constraint
does.

The function is tested exhaustively over every `(state, transition, actor)` triple.

## 5. Agent runtime

### 5.1 The runner

Each agent image contains the **runner**, a small TypeScript program, and the CLIs of both
backends (in the MVP, Claude's only; §12). The runner reads its configuration from the gateway, drives the backend's SDK, and
translates everything the SDK reports into Cerebra's event schema (D16):

| Backend | SDK | Questions to the navigator | Messages mid-run | Resume |
|---|---|---|---|---|
| `claude` | Claude Agent SDK | `canUseTool` on `AskUserQuestion` | streaming input | session id |
| `copilot` | GitHub Copilot SDK | `onUserInputRequest`, elicitation | `send` | `resumeSession` |

**Skills.** Before starting the SDK the runner installs the run's skills (`spec.md` §5.5) where
its backend discovers them: instance skills sent in the `start` message, project skills copied from
the checkout's `.cerebro/skills/`. For Claude that is the skills directory of the run's CLI state;
for Copilot, whether its CLI discovers skills the same way is unverified, and the fallback is to
list them in the instructions with their paths.

The runner never uses the Claude SDK's bare mode, which ignores the subscription token the
`claude` backend runs on (D20).

Inside the container the agent runs with every tool allowed: the container is the permission
boundary. The permission callbacks are used only to turn the agent's questions into chat forms.

### 5.2 The runner protocol

The runner connects to the gateway's `/runner` endpoint over a WebSocket on `cerebro-internal`,
speaking the subprotocol `cerebra-runner.v1` and authenticated by the run token it was started with
(`Authorization: Bearer`); the token identifies the run, and through it the project, the agent and
the type. The gateway refuses an unknown token, another subprotocol, and a second runner for a run
already connected, and closes a runner that sends a message it cannot read. The messages and their
fields are typed once, in `packages/shared/src/runner-protocol.ts`, and both sides parse them there:

- **Down:** `start` (backend, model, effort, instructions, interactive, first message, session to
  resume, MCP servers, skills), `user_message`, `answer`, `fetch_files`, `interrupt`, `stop`.
- **Up:** `event` (one normalised agent event with a sequence number), and `files`. A question,
  a status change (active, awaiting input) and a turn's or run's `result` (usage, end reason) are
  events too, so the chat and the supervisor read one ordered stream.

`fetch_files` asks the runner for named files of its checkout, and `files` returns them, each with
its path, content type and bytes, within a size limit per call. It is how anything leaves an
agent's checkout for the backend (mockups, §11), since the backend never reads the checkout itself
(§7). The runner refuses a path outside `/work`. Both arrive with the mockups (roadmap step 8).

**Usage.** The runner reports usage in every `result` it sends: what that turn spent, as tokens
by kind and model, the cost in dollars when the backend gives one (the Claude Agent SDK's
`total_cost_usd`, which the runner turns from a running total into each turn's share), and premium
requests when it gives those (Copilot; the exact field is to be confirmed against the SDK). The
backend adds them to the run's row as they arrive, so a run that dies midway has still recorded
what it spent. The cost views of `spec.md` §10 are queries over runs joined to the item each held;
nothing is aggregated ahead of time.

The runner spools events to its home volume until the gateway acknowledges them, so a restart of
the main container loses nothing the agent produced; on reconnect it resends from the last
acknowledged sequence number (v1: in the MVP a runner that loses the gateway fails its run).

### 5.3 Run lifecycle and recovery

The supervisor creates the checkout (§7), resolves the secrets, creates the container and waits
for the runner's connection. A run that has waited for the navigator (`awaiting_input`) longer
than its type's idle timeout is **parked** (v1): its container is stopped and removed, the run
becomes `idle` and keeps its item, its conversation stays in the named agent's CLI state directory,
and the navigator's next message or answer resumes it in a new container with the same session. In
the MVP nothing is parked, and a waiting run keeps its container (`spec.md` §6.1, §14).

A run that cannot start (missing credentials, a container the engine refuses, a runner that does
not connect within a minute) ends `failed` with the reason, and nothing the navigator sent is
kept waiting on it. A runner that disconnects without a final result fails its run; a run the
navigator stops is sent `stop` and is ended `finished` once the runner reports its result, or
after thirty seconds. Every ending closes the connection, releases any held item through the
lifecycle, and stops and removes the container (an ending the database refuses is retried, and
one it keeps refusing is left to the next startup's recovery). A named agent has at most one live run, which the
database enforces. Its containers are held to the same rule: before a run's container is created,
every earlier container labelled with the same agent is stopped and removed, and a start that cannot
prove them gone fails, so the agent's home and CLI state are never mounted by two containers (D17).

On startup the supervisor reconciles every run the database thinks is live against the engine's
containers: a container still running is left to its runner, which reconnects; a run whose
container is gone is failed, and the item it held goes back to its queue (`spec.md` §4.5). In the
MVP (D1) no runner reconnects: every live run is failed on startup ("Cerebra restarted while the
run was live."), its item goes back to its queue, and a new conversation begins separately.

### 5.4 The agents' tools

The backend serves the tools of `spec.md` §6.3 as an MCP server on `cerebro-internal`, over
streamable HTTP, authenticated by the run token. The runner configures the SDK with that server.
A tool never takes a run or item id the token already implies, and every call is checked against
the calling type's allowed tools and the lifecycle.

The endpoint is `POST /mcp` on the main container, stateless: each request is one JSON-RPC
message answered with one JSON response, with no session and no event stream (`GET` and `DELETE`
answer 405). It sits outside `/api`, so the navigator's session does not apply; a missing or
ended run's token answers 401, and a request carrying an `Origin` header, which only a browser
sends, answers 403. The supervisor's `start` message names it as the `cerebra` MCP server, with
the run token as its bearer.

`tools/list` answers the tools the calling type allows that exist so far. Every `tools/call` is
checked, in order, against the type's allowed tools, the run's project (an item of another
project is refused, not hidden), the item the run holds, and the lifecycle, whose pure transition
function also refuses a transition without the record it needs (`spec.md` §4.4, §4.11), and an
agent's record on a move that takes none, so an agent cannot write a record of the backend's kind. A refusal
is a tool result with `isError` set and `{ "error": code, "message": … }` as its text, so the
agent can read why; an unexpected failure is a JSON-RPC internal error that names nothing.
`transition` and `wait_for_navigator` act only on the item the run holds, re-checked under the
item's row lock. `create_item` always files into `new` with no priority, whatever the agent
passes, and records the filing run (`work_items.filed_by_run_id`) and the item it held
(`work_items.discovered_from_id`) as the item's provenance (`spec.md` §4.10, D35).

## 6. Dispatcher and scheduler

The **dispatcher** runs when an item changes state, a run ends, an agent is enabled or a limit
changes, and on a timer as a fallback. For each project that is not paused, for each agent type
with a state trigger, it takes the free agents of that type and the claimable items the type
serves (unblocked, unheld, highest priority first, then oldest), and pairs them until it runs out
of either or reaches the project's run limit. The instance ceiling is applied across projects in
the order items became claimable, so no project is ranked above another (D30); one Claude
subscription serves every project, so the ceiling is also what keeps the fleet inside its rate
limit. Each pairing is one transaction:
claim the item, insert the run. Every decision, including a refusal, is logged with its reason.

The **scheduler** evaluates each type's cron expressions in UTC once a minute. A tick that comes
due fires once; one refused by a limit, the project pause or a missing credential is spent, and
ticks missed while the instance was down are not replayed.

## 7. Git model

- **Mirror.** The main container keeps one bare mirror per project under `/data/projects/<id>/`,
  fetched from GitHub on a timer and before every checkout. Only the backend writes it.
- **Checkout.** Each run gets a clone of the mirror at the base it needs (the default branch, or
  the item's pull-request branch for a reviewer or for rework), under `/data/runs/<id>/work`,
  with `origin` pointing at GitHub. The mirror is used only to make the clone fast.
- **Pushing.** The agent pushes to GitHub and opens its pull request with its own GitHub token
  (D10). The backend does not relay pushes.
- **Never inside an agent's checkout.** Once a run has started, the backend runs no git command
  in its checkout: an agent controls that checkout's configuration, and git configuration can run
  commands. Diffs for the UI come from the pull request, or from fetching the pushed branch into
  the mirror. A finished run's checkout is deleted as a directory.

## 8. GitHub

One client behind a `Forge` interface (D12). The backend polls, since a local instance cannot
receive webhooks: pull requests of items in `review_ready`, `reviewing` and `merging`; check runs
of items in `merging`; reviews on the pull requests of items waiting at the `code_review`
checkpoint, of which only those by the navigator's GitHub login (an instance setting) count
(D33); issues for the inbox agent's schedule. A merge uses the backend's own
project GitHub token (`spec.md` §7), which no run is given, through the merge API, then deletes the branch. A server
deployment can add webhooks as a faster path; polling stays the fallback.

### Releases

`record_release` is served by the MCP module to the assistant type only. The backend fetches the
mirror, checks that the commit exists and is on the default branch, and takes as the release's
items every `done` item whose merge commit is an ancestor of it and not of the previous release's
commit — git run in the backend's own mirror, never in the agent's checkout (§7).

## 9. Secrets

Envelope encryption: each value is encrypted with a data key, and data keys with a master key the
main container reads from a Podman secret at startup. Values are decrypted only to start a run,
and handed to the engine as environment variables or as files on a tmpfs mount; they are never
logged, never returned by the API, and never written into a checkout. Resolution follows
`spec.md` §7: agent type in the project, agent type instance-wide, project, instance.

The MVP stores instance and project credentials; agent-type scope comes later. Every value
(`credentials`) is sealed with AES-256-GCM under its own random data key, which is itself sealed
under the master key. The local launcher creates the external Podman secret
`cerebra-project-token-key` once and reuses it across starts and updates. Main reads it through
`CEREBRA_PROJECT_TOKEN_KEY_FILE`; an unreadable or malformed configured key prevents startup.
Legacy direct backend deployments may instead provide `CEREBRA_PROJECT_TOKEN_KEY`, never both
sources. Without either source the credential and project-registration routes answer 503.
When the secret is absent, the launcher checks for existing encrypted records before generating
anything; existing ciphertext requires importing its original key, and a failed check stops
startup. Deliveries (`agent_credentials`) are declared
per project and agent type, by name, as an environment variable or an absolute file path outside
`/work`. Two are built in and need no declaration: `Claude sign-in token` as
`CLAUDE_CODE_OAUTH_TOKEN` to every type, and `GitHub access token` as `GH_TOKEN` to producer,
bugfixer and assistant. `resolveForRun` returns exactly the variables and files a run may receive,
or the names it cannot have (missing, undecryptable, or failed at injection); a run with any
problem does not start, and the Credentials page lists each problem until it is replaced or
removed. The project GitHub token stays on `projects` and is never resolved for a run.

Known limit: an agent can print what it was given, and its transcript is stored as it is.

## 10. Persistence

**Postgres** holds everything the UI shows: projects and settings, agent types and overrides with their revisions,
named agents, work items with their records, comments, dependencies and history, runs and their
events, schedules, secrets (encrypted), users, and the dispatcher's decision log.

**`/data`** (a volume of the main container) holds what does not belong in a database: the git
mirrors, run checkouts, and each named agent's home and CLI state directory.

### Backups

Three layers, each covering what the others do not (D31):

- **The board mirror.** Every project's board is continuously written to the orphan branch
  `cerebro/board` of its own repository and pushed (`spec.md` §11). The backend renders each changed
  item to a file in a private worktree of the project's mirror (never an agent's checkout),
  commits the batch at most once a minute and pushes it with the project's token. A failed push
  is retried with the next batch and shown on the project; it never blocks a board write. Restore
  reads the branch into an empty project.
- **Database dumps.** A scheduled `pg_dump` (daily by default, a configured number kept) to a
  directory the navigator mounts, covering what the mirror leaves out: runs and their events,
  agent definitions and revisions, encrypted secrets, settings.
- **Agent state.** `/data/agents` (each named agent's home and CLI state) is copied alongside the
  dump. Mirrors and checkouts are rebuilt, never backed up.

Restoring an instance is: restore the latest dump, then replay each project's board branch over
it, so board changes made after the dump are not lost.
The encryption master key must also be retained in a separately protected backup and restored as
the same Podman secret before starting the restored instance; database dumps do not contain it.

### Data model (outline)

The tables the MVP needs, named so that the first migrations have a starting point; columns beyond
the ones the lifecycle depends on are the implementer's.

| Table | Holds |
|---|---|
| `users`, `sessions` | The navigator (one row in v1) and their login sessions. |
| `projects` | Remote, default branch, settings (§3 of the spec), involvement preset, limits, pause, and whether its default fleet has been created (so an emptied fleet is never refilled). |
| `agent_types`, `agent_type_overrides` | Instance defaults, seeded on start from `packages/backend/agent-types/` without overwriting a stored type, and per-project overrides (only the fields changed). |
| `agents` | Named agents: project, type, name, enabled. |
| `items` | `key`, `title`, `description`, `type`, `priority`, `state`, `holder_run_id`, `waiting_reason`, `waiting_kind`, `return_state`, `involvement`, `attempts`, `rounds`, `filed_by`, `source`, `parent_id`. The constraints of §4 live here. |
| `item_dependencies` | `(item, depends_on, kind)`. |
| `item_records` | `(item, kind, version, body, created_by_run)`; attachments such as mockups beside them. |
| `item_comments`, `item_history` | Discussion; every state change with actor, reason, from and to. |
| `runs` | Project, agent, type revision, item held, state, container id, backend session id, token hash, usage and cost, started and ended. |
| `run_events` | `(run, seq, event)`: the normalised event stream the chat view replays. |
| `secrets` | Name, scope, encrypted value, data key, last use. |
| `dispatch_log` | Every dispatcher and scheduler decision, with its reason. |

### Agent events

The event schema the runner normalises both backends into, and the chat view renders. Its exact
fields are pinned by the first increment that needs them (`roadmap.md`); the kinds are:
`message` (assistant text; whole blocks in the MVP, streamed deltas later), `thinking`, `tool_call` and `tool_result` (with
diffs for file edits), `subagent_start` and `subagent_end` (nesting everything between), `question`
and `answer`, `user_message`, `status` (active, awaiting input, idle), `error`, and `result` (the
end of a turn or a run, with what it spent). The runner's fields are pinned in
`packages/shared/src/runner-protocol.ts`.

## 11. The web UI

A single-page application served by the main container. It reads over REST and subscribes over
one WebSocket per open view: run events for a chat, item changes for a board. Postgres
`LISTEN/NOTIFY` fans a committed change out to every subscriber. In the MVP one backend process
owns every run, so a chat's socket (`/ws/runs/:id?after=n`) replays the recorded events after `n`
and then receives the supervisor's in-process updates once each event is committed; `LISTEN/NOTIFY`
is needed only when more than one process writes. Agent output is rendered as text:
no raw HTML from an agent reaches the page, and a strict Content-Security-Policy on every response
is the second layer: scripts, connections and everything else only from the page's own origin, no
framing, no plugins. Styles also allow inline, because Radix's scroll lock injects a `<style>`.

React with Vite, using shadcn/ui with Radix primitives and Tailwind CSS (D44, D45). Component
source is maintained in `packages/ui`; detailed screens and wording are agreed in UX sessions.
The first application UI supports persistent Light/Dark/System themes and the WCAG 2.2 AA
accessibility target of `spec.md` §12.

**Mockups.** `show_mockups` has the gateway fetch the named files from the run's checkout with
`fetch_files` (§5.2) and stores them with the item's records. They are served from a second listener on its own port, so they have an origin
of their own, with `Content-Security-Policy: sandbox allow-scripts` and no network access
(`connect-src 'none'`, `default-src` limited to the mockup itself), and shown in the UI in
sandboxed iframes. A mockup's script can therefore run but can reach neither Cerebra's page, its
cookies, the API, nor anything else.

**Notifications.** A push is sent to every open tab over its WebSocket, which raises a browser
notification through the Notifications API unless the tab reports that the chat it concerns is in
focus. The webhook is posted by the backend, retried a few times, and a delivery that fails for
good is shown in the feed. Nothing needs a service worker or a vendor push service.

**Authentication.** v1 has one user, created at first start with a password the navigator
chooses, and a session cookie. The users table, the session handling and the authorisation check
on every request exist from the start, so a server deployment adds users rather than
authentication.

## 12. Images

- `cerebro-main`: the backend, built UI, Git and CA certificates for GitHub access.
- `cerebro-agent`: the runner, Node, git, `gh`, the Claude CLI and the Copilot CLI. The MVP
  image carries no Copilot CLI (`spec.md` §14); the Claude CLI is the native binary the Claude
  Agent SDK installs for the platform.
- A project image built `FROM cerebro-agent` from the project's `.cerebro/agent.Containerfile`,
  rebuilt rootless by the backend when that file changes on the default branch (D19). A failed
  build keeps the previous image.

## 13. Testing

Vitest is the workspace test runner. `pnpm install --frozen-lockfile` installs dependencies;
`pnpm run check` is both gates, locally and in GitHub Actions on `ubuntu-latest`: lint, format
checks, typecheck, build, unit and real-Postgres database tests (D44). Foundations implements this
contract and documents how to provide the database; real-Podman end-to-end coverage arrives at
roadmap step 7.

- **Lifecycle:** every `(state, transition, actor)` triple, and every invariant as a database
  constraint test.
- **Dispatcher and scheduler:** pure functions over a snapshot of items, agents and limits.
- **Engine, forge, clock:** behind interfaces with fakes, so the backend is tested without Podman,
  GitHub or real time.
- **Runner:** each backend adapter against recorded SDK event streams; the protocol against a fake
  gateway.
- **End to end:** a stub agent image whose runner replays a script instead of calling a model,
  started by the real supervisor under real Podman in CI.
