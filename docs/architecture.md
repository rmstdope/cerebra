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
its path, content type and bytes (base64), at most 64 paths and 8 MiB per call. It is how
anything leaves an agent's checkout for the backend (mockups, §11), since the backend never reads
the checkout itself (§7). The runner refuses the whole request if any path is outside `/work`
(absolute, through `..`, or through a link), missing or not a file; the supervisor refuses an
answer that is not exactly the files asked for, and gives up after thirty seconds. Both arrived
with per-run checkouts (roadmap step 6); the mockups use them at step 8.

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
lifecycle, stops and removes the container, and then deletes the run's checkout (an ending the
database refuses is retried, and one it keeps refusing is left to the next startup's recovery).
A checkout that cannot be made (GitHub unreachable, a branch that is not there) fails the start
with that reason, before any container exists. A run whose `transition` or `wait_for_navigator` leaves it holding nothing ends `finished` when
its current turn ends, so a groomer's conversation finishes once the item has left grooming.
A named agent has at most one live run, which the database enforces. Its containers are held to the same rule: before a run's container is created,
every earlier container labelled with the same agent is stopped and removed, and a start that cannot
prove them gone fails, so the agent's home and CLI state are never mounted by two containers (D17).

On startup the supervisor reconciles every run the database thinks is live against the engine's
containers: a container still running is left to its runner, which reconnects; a run whose
container is gone is failed, and the item it held goes back to its queue (`spec.md` §4.5). In the
MVP (D1) no runner reconnects: every live run is failed on startup ("Cerebra restarted while the
run was live."), its item goes back to its queue, and a new conversation begins separately.
Recovery deletes each failed run's checkout, then sweeps `/data/runs/` of every run directory
whose run is not live, so a crash between making a checkout and ending its run leaves nothing.

### 5.4 The agents' tools

The backend serves the tools of `spec.md` §6.3 as an MCP server on `cerebro-internal`, over
streamable HTTP, authenticated by the run token. The runner configures the SDK with that server.
A tool never takes a run or item id the token already implies, and every call is checked against
the calling type's allowed tools and the lifecycle.

The endpoint is `POST /mcp` on the main container, stateless: each request is one JSON-RPC
message answered with one JSON response, with no session (`GET` and `DELETE` answer 405). A call
still unsettled after 20 seconds, from a client that accepts `text/event-stream`, is answered as an
event stream instead: a comment every 25 seconds keeps the connection alive, and the response is
its one `message` event. A client that goes away aborts the call. The runner gives the `cerebra`
server a tool-call timeout of a day, so a `submit_plan` waiting for the navigator is not cut off. It sits outside `/api`, so the navigator's session does not apply; a missing or
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
(`work_items.discovered_from_id`) as the item's provenance (`spec.md` §4.10, D35); the board
shows it as the row's "Filed by" line. A groomer's `transition` out of grooming is also checked
against the run's recorded events: the newest outcome question it asked (the shape shared with the
UI in `@cerebra/shared`) must have an answer naming the route of `to`, and the record's five sections
must equal the ones the navigator confirmed, whitespace aside. A designer's `transition` from
`designing` to `build_ready` is checked the same way against the newest design confirmation it
asked: it must be answered "Looks right — hand it to building", and the `design` record's four
sections and `## The mockup` must equal the confirmed experience and drawing. A refusal says what
to do next and that nothing was moved.

A designer's round of drawings waits in `drawings.ts`, one round per run and in memory: the round
is written into the run's conversation as a `drawings` event, the run shows as awaiting input, and
the asking call returns once the navigator answers with `POST /api/runs/:runId/drawings-answers`
(`{ drawingsId, choice }` naming a drawing of the round, or `{ drawingsId, text }` with what to
change), written as `drawings_answer`. While `show_mockups` fetches and checks a set, its round is
first written as `drawings_preparing` with the question and how many drawings are coming, the run
still active; the set's `drawings` event then fills in that same round. A newer round, an abandoned
call or a set refused before it was shown writes `drawings_withdrawn`; an answer to a round that is not the run's waiting one is refused as
`not_waiting`, and the navigator queue lists each live run's waiting round as a question.

A builder records its plan with `submit_plan` and each run of the project's checks with
`report_checks`, both only while it holds the item in `building`; each is a record carrying the
run that wrote it (`item_records.created_by_run`). The lifecycle reads the holding run's records as
build evidence and refuses `building → review_ready` without a plan or with a latest checks report
that failed. Under the `plan` or `full` involvement, `submit_plan` records the plan as needing
approval and then waits (`plan-approvals.ts`): the plan is written into the run's conversation as a
`plan_approval` event, the run shows as awaiting input, and the call returns once the navigator
answers with `POST /api/runs/:runId/plan-answers` (`{ planId, verdict: "approved" | "changes",
text }`). The answer is kept as a `plan_answer` record and written to the conversation, and the
lifecycle refuses `building → review_ready` unless the newest plan's answer is an approval. A
`submit_plan` call the runner abandons stops waiting and writes `plan_withdrawn`. An answer to a
plan that is not the newest, is already answered or withdrawn, or whose run has ended is refused
as `not_waiting`; the navigator queue lists the newest unanswered plan of each live run. The tool layer also refuses a pull request outside the project's repository or on a
branch not named after the item's key. The Overview reads these records, newest 50 at a time,
through `GET /api/work-items/:id/delivery-activity`.

A reviewer records its verdict with `transition` and a `review` record: the verdict, the revision
it reviewed (a commit hash), the link to the review it posted on GitHub, and its findings, each
`blocking` or `advisory` with a file, an optional line and the problem. The lifecycle refuses an
approval carrying a blocking finding and a change request carrying none. The backend's own records
tell the rest of the story on the same trail: `rework_started` when a builder claims an item with
a live pull request, `blocked` for each block (`spec.md` §4.5), `sent_back`, `returned_to_design`
and `merged`. The navigator answers a block with `POST /api/work-items/:id/send-back` or
`/return-to-design` (`{ reason }`), each refused with `not_waiting` once the item has moved on.
A run's first message (`first-message.ts`) is built from the same records: a builder continuing a
pull request is given its branch and link, the blocking findings of the last review, or the block
it was sent back after; a reviewer is given the pull request to review; a builder after a return to
design is given the navigator's reason.

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

In the MVP the triggers are nudges to one coalescing pass: every successful request that changes
something, every run's end, the backend's start, and a 30-second timer. Each pairing takes a
transaction-scoped advisory lock and re-checks the pause, both limits and the agent's freedom
inside it, so two passes never overshoot a limit. A refusal is logged when an item's reason
changes, not on every pass. The running count covers every live run, including ones the navigator
started; a navigator's start is never held back by a limit or the pause. The same planning
explains, for the board, why each ready item has not started (`GET
/api/projects/:id/automatic-starts`); the Cerebra-wide limit lives in `instance_settings`.

The **scheduler** evaluates each type's cron expressions in UTC once a minute. A tick that comes
due fires once; one refused by a limit, the project pause or a missing credential is spent, and
ticks missed while the instance was down are not replayed.

## 7. Git model

- **Mirror.** The main container keeps one bare mirror per project at
  `/data/projects/<id>/mirror.git`, fetched from GitHub before every checkout (and, from later
  steps, on a timer), one fetch at a time per project. Only the backend writes it; a mirror that
  is missing is cloned again. The backend runs git with no global or system configuration and
  the project's token passed only for that command, never stored in the mirror.
- **Checkout.** Each run gets a clone of the mirror at the base it needs (the default branch, or
  the item's pull-request branch for a reviewer or for rework), under `/data/runs/<id>/checkout`,
  owned by the agent user. It is cloned with `--no-hardlinks`, so it shares no file with the
  mirror, and before the run starts its `origin` is pointed at GitHub — the one git command the
  backend runs inside it, before any agent has touched it. The mirror is used only to make the
  clone fast.
- **Pushing.** The agent pushes to GitHub and opens its pull request with its own GitHub token
  (D10). The backend does not relay pushes.
- **Never inside an agent's checkout.** Once a run has started, the backend runs no git command
  in its checkout: an agent controls that checkout's configuration, and git configuration can run
  commands. Diffs for the UI come from the pull request, or from fetching the pushed branch into
  the mirror. A finished run's checkout is deleted as a directory.

## 8. GitHub

One client behind a `Forge` interface (D12). The backend polls, since a local instance cannot
receive webhooks: pull requests and check runs of items in `merging`; reviews on the pull requests
of items waiting at the `code_review` checkpoint, of which only those by the project's review
account count (D33); issues for the inbox agent's schedule. A merge uses the
backend's own project GitHub token (`spec.md` §7), which no run is given, through the merge API,
then deletes the branch. A server deployment can add webhooks as a faster path; polling stays the
fallback.

The **merge watcher** (`merge-watcher.ts`) makes one pass over the items in `merging` at start, on
every successful mutating request and every 30 seconds. For each it reads the pull request: a head
other than the approved revision blocks it as changed since approval; a conflict blocks it; any
failed check run or commit status on the head, read across every page, blocks it, since every
check counts as required until branch protection is read; pending checks, or GitHub not yet
knowing whether it merges, leave it for the next pass. A head nothing checks at all waits five
minutes after the approval, for checks that were going to start, and then merges. Otherwise it
squash-merges with the approved revision as the expected head, so a push that lands in between is
refused by GitHub rather than merged, deletes the branch and moves the item to `done`. Any other
refusal, and a pull request closed without merging, blocks it as *GitHub refused the merge* with
GitHub's words. A pull request found already merged is finished the same way. Each item's other
failures are logged and leave it in `merging` for the next pass. The same pass closes, with the
navigator's reason as a comment, the still-open pull request of every item returned to design
whose closing is not yet recorded, and deletes its branch; the record written after makes that an
outbox that survives a restart.

Before `merging`, the same pass reads the reviews of every item waiting at the `code_review`
checkpoint, so an approval merges in that pass. The account that counts is the project's review
account as it was when the wait began, kept on the item's `awaiting_code_review` record, and is
matched case-insensitively; a review submitted before the wait began is ignored. An approval moves
the item to `merging`; requested changes move it back to `build_ready` with a `navigator_review`
record carrying the review's body, its line comments and its link, which the next builder's first
message quotes, and count a round like the reviewer agent's. An approval by any other login is
recorded once as `review_not_counted`, so the trail says why nothing moved.

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
bugfixer, reviewer (which posts its review on the pull request) and assistant. `resolveForRun` returns exactly the variables and files a run may receive,
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
  agent definitions and revisions, encrypted secrets, settings. The backend records every attempt
  in `backups`; one runs at a time, a time missed while stopped is caught up once at start, and a
  failure is shown in the navigator queue until a later dump completes.
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
| `projects` | Remote, default branch, settings (§3 of the spec), involvement preset and review account, limits, pause, whether it raises browser notifications, and whether its default fleet has been created (so an emptied fleet is never refilled). |
| `agent_types`, `agent_type_overrides` | Instance defaults, seeded on start from `packages/backend/agent-types/` without overwriting a stored type, and per-project overrides (only the fields changed). |
| `agents` | Named agents: project, type, name, enabled. |
| `items` | `key`, `title`, `description`, `type`, `priority`, `state`, `holder_run_id`, `waiting_reason`, `waiting_kind`, `return_state`, `involvement`, `attempts`, `rounds`, `filed_by`, `source`, `parent_id`. The constraints of §4 live here. |
| `item_dependencies` | `(item, depends_on, kind)`. |
| `item_records` | `(item, kind, version, body, created_by_run)`; attachments such as mockups beside them. |
| `mockups` | `(id, work_item, run, path, content_type, content)`: a drawing the designer showed, served by id from its own origin (§11). |
| `item_comments`, `item_history` | Discussion; every state change with actor, reason, from and to. |
| `runs` | Project, agent, type revision, item held, the item it first claimed (`work_item_id`, kept after the hold ends, so cost stays attributed; null for a run that never held one), state, container id, backend session id, token hash, cost, started and ended. |
| `run_model_usage` | `(run, model)`: input, output and cache tokens, added to as each result arrives, so a run that later fails keeps what it spent. |
| `run_events` | `(run, seq, event)`: the normalised event stream the chat view replays. |
| `secrets` | Name, scope, encrypted value, data key, last use. |
| `dispatch_log` | Every dispatcher and scheduler decision, with its reason. |
| `instance_settings` | One row of Cerebra-wide settings: the instance run limit. |

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
`fetch_files` (§5.2) and stores each in the `mockups` table, beside the item's records, under an
unguessable id; HTML and PNG, JPEG, GIF, WebP and SVG images are accepted, told apart by the path's
extension and checked against the content. A set is shown whole or not at all: between 1 and 64
drawings, 8 MiB together, every file checked before any is stored, and a refusal names what to fix
and says nothing was shown. A second listener
(`CEREBRA_MOCKUP_PORT`, 4318, reached at `CEREBRA_MOCKUP_ADDRESS`, `http://127.0.0.1:4318`, the
interface compose publishes it on) serves `GET /mockups/:id`, so
drawings have an origin of their own and never see the session cookie; it reads no cookie, and
the id is the capability. Every response carries `Content-Security-Policy: sandbox allow-scripts`
with no network access (`default-src 'none'`, `connect-src 'none'`, only inline scripts and styles
and `data:`/`blob:` images and fonts), `nosniff`, `no-referrer` and `no-store`; an image is wrapped
in a page that shows it inline. A mockup's script can therefore run but can reach neither
Cerebra's page, its cookies, the API, nor anything else, and anything it tries to load from outside
is simply missing. The application's own policy allows frames from that origin only. The UI asks
`GET /api/mockups/:id` for a drawing's address, then shows it in a card as a still picture — an
iframe with an empty `sandbox`, `inert`, drawn at four times the card's size and scaled down — and
full size live, with `sandbox="allow-scripts"`. Keys pressed inside a frame stay there, so the
served page posts `cerebra-mockup:escape` to its parent on Escape and the dialog closes on that
message from its own frame. A live drawing's script can still navigate its own frame to another
address, which no policy served with the drawing can prevent; that is accepted for the MVP.

**Notifications.** The backend reads the attention list (questions, waiting work and trouble) every
five seconds and diffs it against the entries it has already seen; the first read after a start
only seeds, so a restart pushes nothing again. New entries are gathered for 30 seconds and sent as
one batch to every open tab over `/ws/notifications`, which raises one browser notification through
the Notifications API. Each tab reports which chat it has in focus, and an entry for a focused chat
or a project whose browser notifications are off is never pushed; the header count is unaffected
by either. The webhook is posted by the backend, retried a few times, and a delivery that fails for
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
checks, typecheck, build, unit and real-Postgres database tests (D44). A second CI job runs
`pnpm run test:e2e`, the real-Podman suites below.

- **Lifecycle:** every `(state, transition, actor)` triple, and every invariant as a database
  constraint test.
- **Dispatcher and scheduler:** pure functions over a snapshot of items, agents and limits.
- **Engine, forge, clock:** behind interfaces with fakes, so the backend is tested without Podman,
  GitHub or real time.
- **Runner:** each backend adapter against recorded SDK event streams; the protocol against a fake
  gateway.
- **End to end:** a stub agent image whose runner replays a script instead of calling a model,
  started by the real supervisor under real Podman in CI. The image is `images/stub-agent.Containerfile`,
  `FROM cerebro-agent`; its runner reads `.cerebra-stub.json` from the checkout, asks `get_item`
  which state the held item is in and how many times it has entered it, and replays that round's
  steps: say something, run a command in the checkout, or call a board tool. The test composes the
  whole backend, serves the project's repository with `git daemon` and fakes only GitHub's API. The
  engine contract runs in the same job against the same socket.
