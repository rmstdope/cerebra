# Cerebra: decisions and open questions

The log behind `spec.md` and `architecture.md`. Each decision says what was chosen and why, so
the other two documents can state the result without arguing for it. A decision is changed by
editing its entry and saying so, never by quietly contradicting it elsewhere.

Status: **decided** (the navigator chose), **proposed** (drafted, awaiting the navigator), or
**open** (not yet discussed).

## Decisions

### D1. Deployment is local first, server later — decided

One navigator runs Cerebra on their own machine. Nothing in the design may assume that, though:
the web UI authenticates even on localhost, and every boundary a hosted, multi-user version needs
(users, sessions, per-request authorisation) exists from the start with exactly one user in it.

The navigator manually installs and updates the local instance when convenient. MVP updates may
interrupt live runs: a backend restart fails them and returns their held items to their queues.
Confirmed during project definition on 2026-09-28.

### D2. One instance serves many projects — decided

A project is a registered GitHub repository. Agent definitions are instance-wide defaults that a
project copies and overrides; secrets have instance and project scope.

### D3. Everything runs in rootless containers — decided

The main container (backend and web UI) and every agent container run rootless under Podman. On
macOS that is a Podman machine VM. The main container is the only one that can start containers.

### D4. The web UI is the only frontend — decided

The terminal fleet view (`cerebro-tui`) and the Emacs/web console are retired. Nothing is shown to
the navigator through a terminal emulator; agents are rendered as structured chats (D9).

### D5. Work items live in the main database only — decided

Postgres, owned by the main container, is the single system of record for work items and
everything else. Beads and the Dolt database are dropped; an importer migrates an existing beads
board once (spec, *Migration*).

*Why:* the lifecycle needs one transactional store — claiming an item, starting a run and changing
its state must commit together — and once agents reach the board through the backend's tools
rather than a CLI of their own, beads' advantage (every clone writes and syncs) no longer applies.
Portability is given up; a later export can win it back if it is missed.

### D6. The lifecycle is fixed by Cerebra, with optional stages — decided

One canonical state machine for every project. A project can switch the *grooming* (D34),
*design* and *verify* stages off, and chooses how involved the navigator is (D32), but cannot add
or rename states. Agents, the UI and
the dispatcher can therefore all name states.

### D7. One state field; working states are explicit — decided

A work item's `state` is the whole answer to "where is it". Every stage has a queue state and a
working state (`build_ready` → `building`); a working state requires a holder and a queue state
forbids one. The UI reads "Storm is building cb-12" straight off the row. The price, a crashed run
leaving an item in a working state, is paid by one backend rule (spec, *When a run ends*).

Rejected: queue-plus-lease, where "in progress" is derived from a lease on a queue state.
Fewer states, but the answer to "where is it" becomes two fields.

### D8. Review is its own stage, worked by its own agent — decided

A builder opens the pull request and hands the item to `review_ready`; a reviewer agent with a
fresh context approves it or sends it back. Rounds are counted and escalate to the navigator.

### D9. The navigator talks to an agent through a chat view — decided

Every run has a structured chat in the web UI: messages, tool calls, diffs, nested sub-agents, and
the agent's questions rendered as forms. The navigator can type into any running agent.

### D10. Code reaches agents as a worktree; agents push with a scoped token — decided

The backend keeps a mirror of each project and creates a checkout per run, mounted into the agent
container. The agent commits, pushes its branch and opens its pull request itself, with a GitHub
token given to it as a secret. The backend never runs git inside a checkout an agent has written
to (architecture, *Git model*).

### D11. Pull requests merge on the forge, by rule — decided

An approved pull request with green checks is merged by the backend through the GitHub API,
unless the `code_review` or `merge` checkpoint holds it for the navigator (D32).

### D12. GitHub is the only forge in v1 — decided

Pull requests, check status and the issue inbox are GitHub's. The code talks to it through one
interface so another forge can be added later, but none is designed for.

### D13. Named agents stay — decided

Agents are named instances of an agent type (Cyclops and Storm are producers). What a name adds
beyond cosmetics is D17.

### D14. Triage is the navigator's, in the web UI — decided

Ranking a new item and choosing its route (normally grooming; design, build or split when it is
already clear; or cancel) are done by the navigator on the board. An assistant agent may propose a ranking in chat; it never ranks on its own.

### D15. Work items nest to any depth — decided

Any item can have children. Only items without children move through the build stages; a parent
waits in `split` and is done when its last child is (spec, *Parents*).

### D16. Agents run under an in-container runner over native SDKs — decided

Each agent container runs a small Cerebra runner that drives the vendor's own SDK — the Claude
Agent SDK for Claude, the GitHub Copilot SDK for Copilot — and speaks one Cerebra protocol to the
backend: normalised events up, messages and answers down.

*Why:* both SDKs deliver what the chat view needs as first-class callbacks — the agent's questions
to the human (`AskUserQuestion` through `canUseTool`; Copilot's `onUserInputRequest` and
elicitation), permission requests, mid-run messages, sub-agents and resume. Driving the CLIs'
raw JSON output instead works for Claude but Copilot's JSON output has no documented
schema. ACP is the one protocol both agents speak, but both implementations are preview-grade,
it assumes an editor at the other end of stdio, and a free-form question to the human is not
clearly part of it. The runner confines vendor churn to one small program per backend.

*Consequence:* the runner is TypeScript, since both SDKs are first-class there. The backend's
language is free; it is TypeScript too (D21).

Confirmed by the navigator during project definition on 2026-09-28, subject to the runtime spike
in `roadmap.md` step 3. This is the chosen architecture, not a claim that SDK compatibility has
already been demonstrated; the spike must confirm it or revise this decision before it is built on.

**Spike evidence (2026-09-28):** `spikes/claude-oauth/` contains the reproducible first two
runtime probes: a rootless Podman image with Node, the Claude CLI and the Agent SDK, using the
SDK's normal mode and forwarding only `CLAUDE_CODE_OAUTH_TOKEN`; and a separate relay container
on a disposable shared network. It asks the model to call `AskUserQuestion`; `canUseTool` sends
the actual `questions` array to the relay, applies its reply, and the two containers emit only
three non-secret success markers. The attempt on the navigator's Mac stopped before image build
because `podman` is not installed (`podman: command not found`), so this does **not** yet confirm
D16. On a host with rootless Podman and a token exported from `claude setup-token`, run
`spikes/claude-oauth/run-rootless.sh`; its expected markers are documented beside the spike.

**Streaming-input spike evidence (2026-09-28):** `run-stream-input-rootless.sh` builds the same
OAuth-only image and invokes `Query.streamInput` only after the SDK reports that the initial turn
has started its `Bash` `sleep 10` operation. It sends one fixed navigator message and succeeds
only when the active session replies with `EXTERNAL_MESSAGE_ACKNOWLEDGED`; the documented marker
order records both delivery and completion without raw model text or credential values. The
attempt on the navigator's Mac stopped at the wrapper's explicit prerequisite check (`Podman is
required to run this rootless runtime spike.`), before token inspection or image build. Streaming
input is therefore still unconfirmed on this machine; rerun
`spikes/claude-oauth/run-stream-input-rootless.sh` on a rootless-Podman host with the subscription
token exported to confirm or revise D16.

**Session-resumption spike evidence (2026-09-28):**
`run-resume-session-rootless.sh` starts an OAuth-only agent container with a disposable,
unprivileged named state volume, records the SDK-provided session ID inside that volume, removes
the container, and starts a replacement with the same volume. The replacement supplies that
unprinted ID to `options.resume` and must return a fixed token from the prior turn before printing
its non-secret success markers. The attempt on the navigator's Mac stopped at the wrapper's
explicit prerequisite check (`Podman is required to run this rootless runtime spike.`), before
token inspection, image build, or state creation. Session resumption is therefore unconfirmed on
this machine; rerun `spikes/claude-oauth/run-resume-session-rootless.sh` on a rootless-Podman host
with the subscription token exported to confirm or revise D16.

**Authenticated MCP spike evidence (2026-09-28):** `run-mcp-rootless.sh` prepares an external,
streamable-HTTP MCP server on the same disposable rootless Podman network as the OAuth-only
agent. The server refuses every request without the run's exact bearer token before it exposes its
single deterministic tool; the SDK receives the token only in its HTTP MCP-server configuration,
calls that tool, and requires the fixed tool-result marker before reporting success. The attempt
on the navigator's Mac stopped at the wrapper's explicit prerequisite check (`Podman is required
to run this rootless runtime spike.`), before either credential is inspected or an image is built.
Authenticated MCP remains unconfirmed on this machine; rerun
`spikes/claude-oauth/run-mcp-rootless.sh` on a rootless-Podman host with the subscription token
and a per-run MCP bearer token exported to confirm or revise D16/D20.

### D17. A named agent is an identity with a memory — decided

Each named agent in a project keeps its own home directory and CLI state across runs: the
backend's auto-memory, resumable conversations, tool caches. A name runs at most one run at a
time, so its state is never shared by two runs, and the number of enabled names of a type is the
type's concurrency limit in that project.

**Spike evidence (2026-09-28):** the session-resumption probe described under D16 mounts one
disposable named volume at the unprivileged agent's `CLAUDE_CONFIG_DIR` in two separately-created
containers and removes both the first container and volume on exit. This Mac lacks Podman, so the
run stopped before state creation and does not yet demonstrate that persisted CLI state and
`options.resume` meet D17. No architectural consequence follows yet: D17 remains the chosen
design, pending the documented rootless-Podman run.

### D18. Any agent may ask the navigator — decided

The designer, verifier and assistant are conversations by design; every other type runs
unattended but may still ask a question. Asking puts the run in `awaiting_input` with the item
still held; after the type's idle timeout the run is parked — its container is stopped, it keeps
the item, and the conversation resumes in a new container when the navigator answers (parking is
v1; in the MVP the container stays up). An agent that is stuck on something no answer will fix moves
its item to `waiting` instead and ends its run.

### D19. A project's toolchain comes from a Containerfile in its repository — decided

A project that needs more than the base agent image keeps `.cerebro/agent.Containerfile`,
starting `FROM cerebro-agent`. The backend builds it rootless whenever it changes on the default
branch, and new runs use the latest successful build. A failed build keeps the previous image and
tells the navigator.

### D20. Claude runs on the navigator's subscription token — decided

The model credential for the `claude` backend is a `CLAUDE_CODE_OAUTH_TOKEN` from
`claude setup-token`, as classic Cerebro's fleet runs. The navigator accepts the plan's terms for automated
use; an API key is not designed for (it would be the same secret slot if ever wanted). Consequence:
the runner must not use the SDK's bare mode, which ignores that token. Copilot runs on a
fine-grained personal PAT with the "Copilot Requests" permission, billed to that seat.

**Spike evidence (2026-09-28):** the OAuth-only probe described in D16 was prepared without an
API-key fallback and explicitly leaves bare mode disabled. Its real rootless-container and
external-question-relay run is blocked on this Mac because Podman is absent, before the token is
read or emitted. D20 remains unconfirmed until the documented command runs successfully on a
rootless-Podman host.

**Streaming-input spike evidence (2026-09-28):** the streamed-input probe uses the same
`CLAUDE_CODE_OAUTH_TOKEN`-only, non-bare image and forwards the token by environment name only.
Its rootless execution is blocked before token inspection on this Mac because Podman is absent;
it neither confirms nor changes D20 until the documented rootless run succeeds.

**Session-resumption spike evidence (2026-09-28):** the replacement-container probe forwards
only `CLAUDE_CODE_OAUTH_TOKEN` by environment name to each agent container and emits neither it
nor the persisted session ID. Its rootless execution stopped before token inspection on this Mac
because Podman is absent, so it neither confirms nor changes D20 until the documented command
succeeds on a rootless-Podman host.

### D21. The backend is TypeScript on Node — decided

One language for the backend, the runner (D16) and the web UI, so the runner protocol, the event
schema and the API types are written once and shared. Node rather than Bun, for its compatibility
record. What Rust would have given — a supervisor and a state machine the compiler holds to account
— is asked of the design instead: the lifecycle is one pure module tested over every transition,
and its invariants are also database constraints.

### D22. Agent egress is open in v1 — decided

Agent containers reach the internet freely on their egress network. The agent type carries a
`network` field and the network layout leaves room for an egress proxy, so a per-type allow-list
can be added without changing either.

### D23. A family is verified as a whole — decided

Children of a `split` parent skip their own verification; the parent is verified once its last
child is done, as classic Cerebro verifies an epic.

### D24. External pull requests are not in v1 — decided

Reviewing pull requests from outside the fleet (Cypher's job in classic Cerebro) is dropped from v1.

### D25. Rework continues the same pull request — decided

When a reviewer, the navigator answering a failed merge, or a failed verification sends an item
back to `build_ready`, the next builder run checks out the item's existing branch and pushes to the same pull request, with
the reviewer's findings or the verdict as its first message. A pull request is closed and replaced
only when the item goes back to `design_ready`; the backend closes it, with a comment saying why.

Confirmed by the navigator during project definition on 2026-09-28. Amended by cr-c4f.4: a failed
merge no longer returns the item to `build_ready` by itself; it waits for the navigator as a block
(`spec.md` §4.5), who sends it back to the builder or returns it to design — agreed with the
navigator on 2026-09-29.

### D26. v1 ships nine roles — decided

groomer, designer, producer, bugfixer, reviewer, verifier, assistant, architect and inbox
(`spec.md` §5.3) — eight when this was decided, nine since the groomer was added (D34).
The reviewer is new (D8). The orchestrator becomes the assistant, having lost ranking (D14) and
stopping producers, which the backend does. The inbox is classic Cerebro's user-feedback role (Moira). Cypher goes
(D24).

### D27. Agent definitions live in the database, edited in the UI — decided

The instance's default types are seeded from files shipped in the image. From then on types and
their project overrides live in Postgres and are edited in the web UI; every save is a revision
that can be viewed, compared and restored. An override stores only the fields it changes, so a
newer default reaches every project that has not overridden that field. A run records the revision
it started with.

*Rejected:* definitions as files in the project's repository. Reviewed like code, but a change to
an agent's model or trigger would need a pull request, and the definitions of one instance would be
spread over every repository it serves.

### D28. No export of the board — superseded by D31

Postgres was to be the only copy of the board, with database dumps as backup. The navigator
reopened it: work and code would live apart, with no version history of the board and no copy off
the machine.

### D29. Cerebra is a new repository — decided

It is built in a fresh repository, `rmstdope/cerebra`; classic Cerebro's repository,
`rmstdope/cerebro`, keeps running its own fleet until the new system can take over. These
documents were written there and moved here when this repository was created.

The product name **Cerebra**, distinct from classic Cerebro, was confirmed during project
definition on 2026-09-28. Existing technical identifiers such as `.cerebro/` are unchanged.

### D30. Projects share the instance by per-project limits — decided

Each project has its own run limit and the instance a ceiling over all of them. There is no
ranking between projects: under the ceiling, the item that became claimable first starts first.
One instance is the way to work on several projects at once; a second instance is possible, but
nothing coordinates two, and they would share one Claude subscription blindly.

### D31. The board is mirrored to a branch of its repository; the database is dumped — decided

Postgres stays the only thing written (D5). Each project's board is continuously mirrored, one
Markdown file per item, to an orphan branch `cerebro/board` of the project's own repository, and
pushed; it can be restored from there. The board's commits name the items they change, and the
code's commits carry a `Work-Item:` trailer. A scheduled `pg_dump`
covers what the mirror leaves out.

*Why:* it answers all three of the navigator's objections to D28 — backup (the branch is on
GitHub), history (git log and diff of the board) and work beside code (same repository, trailers)
— without giving up one transactional store. *Rejected:* Dolt per project, as beads does it:
natively versioned, but claiming an item and starting a run would span two databases, and whether
Dolt's row locking holds under concurrent writers is unverified.

### D32. The navigator's involvement is a preset of checkpoints, overridable per item — decided

Four checkpoints — `informed`, `plan`, `code_review`, `merge` — combined into presets
(`autonomous`, `informed`, `plan`, `full`), chosen per project and raised or lowered per item at
triage (`spec.md` §4.9). Replaces classic Cerebro's `navigator_gates` (`plan`, `review`, `merge`). The
reviewer agent's review always runs; the navigator's code review is on top of it.

### D33. The navigator reviews code on GitHub — decided

Under `code_review` the navigator reviews the pull request on GitHub, and the backend reads that
review (approval or requested changes) from the navigator's configured GitHub account. It sits
behind the same forge interface as everything else GitHub (D12), so a review inside Cerebra's own
UI can be added later without changing the lifecycle.

### D34. Grooming agrees an item's outcome before anything is designed — decided

A stage between triage and design: `grooming_ready` → `grooming`, worked by a new interactive
`groomer` role with the navigator. It produces an outcome record (problem, who benefits, outcome as
observable results, out of scope, how we will know) and no UX — what a person sees stays the
designer's. Order: triage first (so no grooming time goes to items that will be dropped), then
grooming. The groomer proposes the route (design, build or split) and the navigator confirms it, so
routing moves from triage to the end of grooming, where it is better informed. Skippable per item
at triage and switchable off per project, like design and verify.

### D35. A groomer's split skips triage; every other filing starts in `new` — decided

Children the navigator has just agreed in grooming inherit the parent's priority and go straight to
the route agreed for each. Everything else an agent files — follow-ups, the verifier's follow-ups,
the architect's and inbox's items — lands in `new` for triage, so the navigator sees every item that
enters the board. Only the navigator (at triage) and a groomer (with the navigator) split an item.

### D36. Releases follow a per-project release skill, run by the assistant — decided

A release is made by the assistant when the navigator asks, following the project's release skill.
The process is unique to each project, so it lives in the project's repository
(`.cerebro/skills/release/SKILL.md`), versioned with the code it releases; Cerebra ships a template.

### D37. Any agent type can carry skills — decided

A type lists skills from two sources: instance skills, stored and revised in the database like
agent types (D27), and project skills from the repository's `.cerebro/skills/`, which replace an
instance skill of the same name. The runner installs them where its backend finds them. Whether
Copilot's CLI discovers skills like Claude's does is unverified.

### D38. A release is recorded — decided

Each release records its version, tag, commit and the `done` items it contains, computed by the
backend from the default branch's history. It drives *shipped since the last release* on the home
page and the inbox's "released" update to linked GitHub issues.

### D39. Costs are recorded per run and attributed through the item it held — decided

Each run records tokens by kind and model and the cost its backend reports (dollars for Claude,
premium requests for Copilot). Its cost belongs to the item it held, or to no item. From that one
attribution come the four views the navigator asked for: per project, per work item (with a
parent's family rolled up), per work item by agent and stage, and costs tied to no item. Under the
Claude subscription (D20) the dollar figure is the API-price equivalent, not a bill; it is kept
because it compares work fairly. Budgets and alerts are not in v1.

### D40. Notifications push only what blocks on the navigator — decided

A run asking a question, an item entering `waiting` (checkpoints included) and trouble with the
instance push; new items only raise the queue's count; `informed` notices go to the feed. Channels
in v1: the app itself, browser notifications while a tab is open, and one optional outbound webhook
(ntfy, Pushover, Slack) for reaching the navigator off the machine. One push per event, batched
over 30 seconds, none for a chat in focus, per-project mute. *Left out:* email (needs SMTP; the
webhook covers the need), Web Push with a service worker, reminders and quiet hours.

### D41. The MVP is what the new repository's own development needs — decided

The first delivery runs one item from `new` through grooming, design, build, review and merge, with
the navigator in the chat, on the Claude backend. The design stage stays in the MVP at the
navigator's request: agreeing the experience before building is what Cerebra is for. Postponed to
v1, each without a redesign: Copilot, the verify stage, nesting, schedules (architect, inbox),
releases, instance skills, revisions of agent types, the board mirror, the cost views, the webhook
and feed, project image builds, surviving a backend restart, and the beads importer
(`spec.md` §14).

### D42. Mockups are shown in the chat, sandboxed — decided

The designer writes mockups as self-contained HTML (or images) in its checkout and publishes them
with `show_mockups`, which asks the navigator to choose among them in the chat. The chosen one is
kept with the item's design record. Mockups are served from their own origin under a sandboxing
Content-Security-Policy, so a mockup's script runs but reaches nothing. Replaces classic Cerebro's `file://`
links to mockups committed in the repository.

### D43. Classic Cerebro's fleet builds the MVP — decided

Until the MVP can run its own development, this repository mounts classic Cerebro as a submodule
and its fleet builds the MVP: beads for tracking, producers with independent review, the
navigator's UX agreement. The step after the MVP (`roadmap.md`, step 9) hands the work over to
this system and removes the scaffolding. *Rejected:* a single Claude session looping over a
checklist — quicker to start, but without tracking or independent review unless the loop enforced
them itself.

### D44. The foundation stack and gate are shared across the workspace — decided

Confirmed during project definition on 2026-09-28:

- One pnpm workspace: `packages/shared`, `packages/backend`, `packages/runner`, `packages/ui`,
  plus `images/` and throwaway `spikes/`.
- The current Node LTS at foundation implementation, pinned in `.nvmrc` and `engines`. Bun was
  reconsidered and declined; D21 stands.
- Fastify with its WebSocket plugin; Postgres with Kysely and its migrator; React with Vite.
- Vitest throughout, with database tests against real Postgres; ESLint, Prettier and strict
  TypeScript.
- `pnpm install --frozen-lockfile` installs dependencies. `pnpm run check` is both the fast and
  full gate: lint, format checks, typecheck, build, unit and database tests, identical locally and
  in GitHub Actions on `ubuntu-latest`. Foundations establishes these commands and documents the
  Postgres prerequisite. Real-Podman end-to-end coverage is added at roadmap step 7.

No application workspace or executable gate exists at project definition time; the declaration is
the contract foundations must implement, not a passing check. Automatic worktree installation is
left undeclared until the foundation producer creates the manifest and lockfile; the harness then
detects `pnpm install --frozen-lockfile` from `pnpm-lock.yaml`. Declaring it before bootstrap
prevented that producer from starting, because pnpm cannot install without a package manifest.
Classic Cerebro's building fleet
keeps its existing Copilot configuration; that is separate from the product's Claude-only MVP.

### D45. The UI is modern, stylish and easy, with accessible themes from the start — decided

The navigator chose **Modern, Stylish, Easy** during project definition on 2026-09-28: simple to
navigate and operate, with powerful controls available when needed. React/Vite uses **shadcn/ui
with Radix primitives and Tailwind CSS**. Its component source is maintained in this repository;
the toolkit is a starting point, not a substitute for agreeing the experience.

The first application UI includes light and dark themes. The initial theme follows the system,
with a persistent Light/Dark/System choice. Accessibility targets **WCAG 2.2 AA**: keyboard access,
screen-reader labels, visible focus, sufficient contrast and reduced-motion support. Components
alone do not establish compliance; the application flows must meet it.

First use is password setup, GitHub project registration and credential configuration, followed
by an honest empty board with a clear way to file the first item. Returning visits open the
cross-project navigator queue. Errors are explicit; history, cancellation, reopening and reasoned
overrides support correcting mistakes. Detailed screens and wording remain for UX agreement.

## Remaining validation and implementation choices

- **Foundations** (`roadmap.md`, step 2) implements D44 and D45. Exact package versions, the
  pinned current Node LTS and lower-level library choices are recorded as they are implemented.
- **The runtime spike** (step 3) tests D16 and D20 against the real SDK. Their chosen status does
  not replace that evidence.
