# Cerebra: product definition and architecture baseline

Status: approved direction; implementation feasibility gates remain open.

Date: 2026-09-21.

Implementation follow-up (2026-09-22): see
[implementation decisions and evidence](implementation-notes.md) and the
[operator guide](operator-guide.md). The interview baseline below is retained
as the original agreement; live-environment acceptance gates are tracked in
the implementation notes.

This document records the initial product and technology interview. It is the
baseline for implementation, not a claim that the integrations below have been
built or tested. Changes to agreed behavior should be explicit decisions rather
than incidental consequences of a library or provider limitation.

## 1. Product purpose

Cerebra is a self-hosted harness through which humans and a fleet of agents own
the software development lifecycle together: discovering and clarifying work,
prioritizing it, designing and implementing it, reviewing and verifying it, and
deploying it to users. User-reported issues feed back into the same process.

The success criteria are **throughput of accepted work and maintained quality**,
not agent count, generated code, or merged pull requests alone.

Initial use is a small installation with several human roles and a couple of
consumer projects. The first release targets 20 concurrent agent executions
across two machines, including two machines working on the same project.
Longer-term adoption may span 1,000+ engineers across teams. That is not a
requirement for one installation or a single shared fleet of that size.

A consumer project is initially **one Git repository**. Teams operate independent
installations. People may participate in multiple projects or installations
without requiring cross-installation identity federation.

### What carries over from Cerebro

- Human-ranked work and agent-managed decomposition and dependencies.
- TDD where it adds value, isolated worktrees, and independent agent review.
- Automatic merges after the applicable checkpoints are satisfied.
- Human verification before or after merge, according to project policy.
- Multiple AI providers.
- Recovery of failed/stuck agents from durable work packages.

Cerebro's implementation, submodule packaging, exact roles, and storage choices
are not compatibility requirements. Beads is selected below on its merits, not
because Cerebro already uses it.

## 2. First-release boundaries

| Included | Deferred |
| --- | --- |
| Multiple human roles and shared role work queues | Automatic fleet sizing or role redistribution |
| Manually configured fleet, initially 20 concurrent executions over two machines | Cloud workers or automatic machine provisioning |
| Independent engine and web UI on each machine | Cross-instance terminal access and answering remote questions |
| Shared transactional backlog and exclusive work claims | Multi-repository consumer products |
| Claude Code and GitHub Copilot CLI subscription logins | Pi/OpenRouter runtime integration; preserve an extension path |
| Full streaming chat and browser terminal for the same live agent session | Teams, Slack, email, and other communication adapters |
| GitHub issue intake, pull requests, reviews, and merges | Alternative Git hosting and external backlog integrations |
| Human-triggered deployment through GitHub Actions | Production monitoring and automated on-call response |
| Local accounts shared across the installation | Enterprise SSO, granular project access control, central organization policy |
| Current durable state, recovery, and compact operational metrics | Cerebra historical event/transcript archive and backup/restore feature |

Incident reporting in this release means accepting externally reported GitHub
issues, not monitoring production. Deployment infrastructure is project-owned:
if a project lacks a deployment workflow/script, creating it can itself be work
assigned through Cerebra.

Self-hosted applies to Cerebra's engines, UIs, and storage. GitHub and remote
model providers remain external dependencies; this is not an offline system.
Deferring cloud workers does not prohibit project-owned GitHub Actions runners.

## 3. Delivery lifecycle

1. A product manager brings a feature idea to an appropriate agent.
2. Human and agent clarify it and record acceptance criteria and work packages.
3. An agent requests human prioritization. A human ranks top-level work.
4. An engine claims eligible, ranked work. Agents decompose it and manage
   dependencies and subtask order.
5. Agents implement the change, involving humans at the project's decision
   boundaries and using TDD where relevant.
6. A separate agent session reviews the change. Findings are recorded on GitHub.
   Project-specific human review and other gates also run.
7. Code merges to main once all applicable checkpoints are cleared.
8. Human end-to-end verification occurs before or after merge if required.
9. A human initiates deployment; an agent or the engine dispatches the appropriate
   project GitHub Actions workflow through `gh` and observes its outcome.
10. User-reported GitHub issues are triaged into the same work process.

A failed post-merge verification produces an urgent bug report. Humans triage
and rank urgent bugs; the system must not silently invent priority or deployment
authority. Production remediation follows the project's human-approved process.

### Backlog semantics

- One explicitly ordered backlog per project, not merely priority buckets.
- Select the highest-ranked ready work compatible with available roles and
  non-conflicting assignments. A blocked item does not stop unrelated work.
- Agents may create/propose new work and order subtasks. Humans rank top-level
  work; major additions require the appropriate human approval.
- Agents handle dependencies. Conflicting human instructions return to humans.
- Prefer preventing overlapping file/component work through sequencing and
  dependencies. Unanticipated conflicts still need resolution; overlap detection
  is not a guarantee that conflicts cannot occur.
- External GitHub issues are intake, not a second authoritative execution board.
  Keep source links and make repeated polling idempotent.

## 4. Humans, agents, and authority

### Human roles

Initial roles are product owner/manager, UX designer, UI designer, architect,
developer, and QA. One person may hold several roles; several people may share
one role. Assignments are explicit per project.

The local dashboard shows questions and work awaiting human attention, grouped
by role. Assigned humans share that role's work. When more people must participate
in a decision, the human receiving the request coordinates them; Cerebra does not
need a multi-signature approval engine initially.

Human reviewers use GitHub. Agent reviewers also publish findings on GitHub.

### Decision policy

Humans retain authority over UX, priority, and deployment. They may pre-authorize
bounded behavior. Small decisions can be delegated in any area within those
bounds; medium/large decisions and uncertain cases are escalated.

Each project describes its autonomy boundaries in human-approved prose. Teams
choose human participation in architecture, test design, code, reviews, and
merging. The definitions of "small" and "major" belong to that policy, not a
universal lines-of-code threshold.

Release-one enforcement is **cooperative prompts and application workflow**, not
a security guarantee against an agent or trusted human bypassing the workflow.
Agents with broad `gh` credentials can potentially merge or dispatch workflows
directly. Containers do not remove those GitHub permissions. GitHub branch and
environment protections can strengthen enforcement, but are not mandatory
Cerebra prerequisites in this baseline.

Local accounts provide authentication, but there is no initial project-level
access isolation. Role assignments route work and express responsibility; they
are not a claim of adversarial authorization enforcement.

### Quality policy

Acceptance criteria and independent agent review are required for applicable
delivery work. Independent means a separate session from the author; a different
model/provider is not mandatory. Projects may specify the reviewing agent
definition and skills. An author must not satisfy its own independent-review gate.

Use failing-then-passing tests when they add value. Documentation-only changes,
agent/skill changes, and other unsuitable work do not require artificial TDD
evidence. This is a pragmatic practice, not a universal test-first mandate.

Human review, CI, security checks, staging/demo, and post-deployment checks may
be mandatory or optional per project. Review disagreements should first be
resolved by agents; involve a human as a last resort.

Implementation should associate review/approval evidence with the change it
covers so subsequent edits do not accidentally inherit obsolete clearance.
Exact evidence formats and policy configuration are implementation work.

### Starter agent responsibilities

| Responsibility | Purpose |
| --- | --- |
| Intake/planning | Clarify ideas, request ranking, decompose work, record decisions |
| Implementation/test design | Build the change and appropriate tests |
| Independent review | Review in a distinct session and report findings on GitHub |
| UX liaison | Work with UX/UI humans and record agreed experience decisions |
| Release coordination | Prepare and execute human-authorized deployment workflows |

These responsibilities are a starting model, not a fixed headcount or one agent
per human role. They may be combined except for author/reviewer independence.
Each configured agent has a well-defined purpose.

An orchestrator agent may suggest new roles, agents, decomposition, or process
improvements. Deterministic engine code owns scheduling, claims, process
supervision, and recovery; an LLM is not the transaction coordinator.

### Identity and context

Agents retain stable identities so humans can build a working relationship with
them. They do not accumulate an unlimited conversation across work packages.
New work is bootstrapped from the current package and relevant repository
documents. Short-lived knowledge belongs in work packages; durable project
knowledge belongs in repository documents.

Human-blocked work keeps its agent slot, CLI process, and container occupied
indefinitely. It retains its current session while waiting; unrelated agents may
continue. There is no automatic human-wait timeout, reassignment, or recycling of
that slot. This deliberately favors continuity over maximum slot utilization.

## 5. Distributed topology

```text
Machine A                                 Machine B
  Local web UI                              Local web UI
       |                                         |
  Cerebra engine                            Cerebra engine
       |                                         |
  Docker agent executions                  Docker agent executions
  local worktrees/checkpoints/logs          local worktrees/checkpoints/logs
       |                                         |
       +------------- private network -----------+
                            |
                    Shared Dolt SQL server
                      - Beads project work stores
                      - Separate Cerebra application database

Each engine and its agents use gh for GitHub operations.
Production credentials stay in GitHub Actions secrets.
```

There is no central leader engine. Every machine schedules and supervises its own
fleet and serves its own web UI. All instances share an authoritative work store
so one machine claiming a package makes it unavailable to another.

The shared database is an availability dependency. Independent engines do not
mean independent, disconnected authorities over the same backlog.

### UI and network scope

- Each UI shows and controls local agents, their conversations, and human requests.
- A question raised on machine A is answered through machine A's UI, not B's.
- Live terminals are reachable only through the UI hosting the execution.
- Shared project backlog and summary metrics can be read from the shared store;
  this does not imply remote agent control.
- Humans on other computers may access a configured instance over a private
  LAN/VPN.
- Bind to localhost by default. Network exposure requires explicit configuration,
  HTTPS, login, and authenticated terminal/chat connections.
- Keep Dolt private-network-only. Public hosting and tunnels are out of scope.

### Ownership and concurrency invariants

1. A work package has one authoritative owner. Claims must be atomic against the
   same shared database branch, not inferred from asynchronously synchronized copies.
2. Ownership identifies the instance and assignment, not only a reusable agent
   display name. Duplicate processes must not treat an idempotent claim as
   permission to execute the same package twice.
3. Claims persist through human waits, laptop sleep, engine restart, and temporary
   disconnection. Normal tasks do not migrate between machines.
4. A permanently lost machine may be handled by explicit human reassignment.
   The previous owner must then be rejected when it attempts authoritative updates.
5. Returning instances revalidate ownership before resuming controlled side
   effects. Do not promise exactly-once execution of arbitrary external commands.
6. Separate review work can be represented as a distinct linked assignment;
   it must not turn a single implementation package into two simultaneous owners.

Beads provides candidate primitives, but the complete fencing/reassignment
contract is unproven. The implementation must establish one claim authority and
avoid a second, conflicting ownership record in the application database.
Checking an owner and later writing without a conditional/atomic guard is not
sufficient. Cooperative GitHub access remains subject to the limitation in
section 4 even if Cerebra's own state transitions are correctly fenced.

### Disconnection and failure

When the shared backlog is unreachable, do not claim new work. Already-owned
work may continue locally, but controlled merge, deployment, and authoritative
completion wait until ownership and policy are revalidated. Do not acknowledge
a durable shared decision if it has only been stored temporarily on one machine.

Detect crashed or stuck executions and recover on the same machine from the
durable package/checkpoint. Keep human waiting and legitimate long-running
commands distinct from lack of progress. Use bounded recovery: at most three
automatic recovery attempts per incident, then mark blocked and request help.
A successful process launch alone must not reset a crash-loop retry budget.

After a host restart, the original process and exact conversation context may
be gone. Durable work context, not a promise of transcript replay, is the
recovery contract. A machine that is merely offline retains its assignments.

Provider quota exhaustion and authentication problems are visible blocked states,
not reasons for endless process restarts. Never silently switch from a
subscription to paid API billing.

### Worktrees and merging

Use one worktree/branch per work item. The sandbox design must support Git
metadata safely without granting every task broad access to unrelated host
files or other worktrees.

Projects configure whether merging a non-rebased branch is allowed. Do not
impose an unconditional rebase requirement. Coordinate conflicting merge work
across instances, revalidate applicable checks against the change being merged,
and use Beads merge slots if their behavior passes the feasibility gate.

## 6. Approved technology direction

| Area | Choice | Rationale / qualification |
| --- | --- | --- |
| Application language | TypeScript on Node.js | One language across engine, agent-facing CLI, and web application; suitable subprocess and web ecosystem |
| Web UI | React + Vite | Client-side dashboard, streaming conversations, and terminal integration without an SSR requirement |
| Local API | Fastify; HTTP and WebSockets | Typed application API plus bidirectional chat/terminal transport |
| Browser terminal | xterm.js | Terminal rendering, not a structured chat parser or agent runtime |
| Agent runtime | Real Claude Code and Copilot CLI executions in containers | Preserve provider tools, skills, and CLI behavior; subscription authentication required |
| Execution isolation | Docker on Linux and macOS | Linux containers on Linux or a Docker-managed Linux VM on macOS |
| Work packages | Beads CLI with structured output | Reuse agent-oriented work tracking, dependencies, claims, metadata, and reviewable work context |
| Shared work storage | One authoritative Dolt SQL server | All instances use server mode against the same project database branch |
| Application data | Separate Cerebra database on the same Dolt server | No second database service; keep application schema separate from Beads internals |
| GitHub integration | `gh`, including `gh api` | Both engines and agents may invoke it; periodic polling is acceptable |
| Deployment | Project-owned GitHub Actions workflows | Human-triggered; production credentials remain GitHub secrets |
| Workspace/package manager | pnpm workspaces | Shared TypeScript contracts and coordinated package development |
| Testing | Vitest + Playwright | Unit/integration testing plus browser workflows |

These are technology choices, not dependency version pins. Pin compatible,
verified versions when the feasibility work establishes them.

### Alternatives and deliberately omitted infrastructure

Rust plus TypeScript remains a credible alternative for a native supervisor.
TypeScript-only is selected because a single application language is valuable,
provider integrations fit its ecosystem, and there is no measured engine
performance problem justifying a second language. The agents and their builds,
not necessarily the engine, will dominate CPU/RAM at the initial scale.

A custom PostgreSQL-backed work tracker could model transactions directly but
would require building the work-package system the project prefers to reuse.
Operating PostgreSQL alongside Beads/Dolt is not selected because avoiding an
additional database service is an explicit goal.

GitHub Issues are retained for external intake and review links, not assumed to
provide the required claim/ownership semantics. Independent Beads databases
using Dolt push/pull are not selected for concurrent claim arbitration.

No Kubernetes, Redis, separate queue broker, or standalone durable-workflow
service initially. Engines reconstruct their scheduling state from durable work
records. Do not replace this with an in-memory-only queue.

### Adapter boundaries

Keep narrow adapters for provider execution, work storage, and human interaction.
Do not build a generic plugin framework before a second implementation needs it.

Agents use a Cerebra CLI inside their sandbox to inspect work, record checkpoints,
and ask questions. The local engine validates updates against the current
assignment and delegates work operations to Beads. Do not expose raw shared
database credentials to agents. MCP is not required initially.

Use documented Beads interfaces rather than modifying its internal schema.
The Cerebra application database owns accounts, sessions, role assignments,
instance registration, and application configuration metadata, not a duplicate
authoritative backlog. Its SQL driver and migration tool remain to be selected
after Dolt compatibility is proven.

PTY/process transport is also subject to the provider spike. `node-pty` is a
candidate where a native PTY is needed; Docker's execution/attach facilities may
provide the required terminal transport. The approved choice is browser terminal
support, not a premature mandate to use both mechanisms.

## 7. Provider and sandbox contract

### Required user experience

Each provider must support a **full structured streaming chat and live interactive
terminal controlling the exact same running session**. Switching views must not
silently create another conversation or substitute a different execution with the
same agent name.

A terminal mirror, ANSI-stripped output, or a chat-only SDK session without the
required terminal access does not meet this requirement. Input from chat,
terminal, and automation needs explicit serialization/control ownership to avoid
interleaving commands.

This requirement is a hard feasibility gate for both initial providers. Current
documentation establishes useful building blocks, not proof of this combined
experience. If permitted provider interfaces cannot support it, stop and obtain
an explicit product decision; do not quietly weaken it.

### Authentication and provider compatibility

Use existing CLI subscription logins for Claude Code and GitHub Copilot.
API-key-only integration is not an acceptable silent substitute. The installer
chooses and provisions the credentials used by the installation/worker.

The Copilot SDK documents a JSON-RPC connection to a Copilot CLI server and
support for stored CLI login credentials. This does not by itself prove
simultaneous structured chat and interactive-terminal attachment.

Claude Code documents subscription login and container login flows. The Claude
Agent SDK documentation separately restricts offering claude.ai login/rate limits
in third-party products without approval and directs such integrations to API
authentication. Do not assume CLI subscription support authorizes every SDK or
embedded/multi-user deployment. Confirm the supported integration and applicable
provider terms, account usage, concurrency, and organization policies before
committing to that path. Do not extract tokens or bypass provider restrictions.

Pi with OpenRouter API keys is a future extension, not a release-one provider.
Provider limits and unsupported capabilities must be explicit.

### Isolation

Agents run with full tool approvals inside a container/VM, not unrestricted on
the host. Internet access, dependency installation, and arbitrary commands
inside the sandbox are allowed.

Do not expose the host Docker socket, broad host-home mounts, raw backlog
credentials, or production deployment secrets inside agent containers. The
trusted local engine may manage Docker; that authority is not passed through to
the agent. Provision only the provider/GitHub credentials needed by the worker.

Docker is the agreed baseline, not a claim of perfect isolation. Native macOS
build/test execution, privileged task containers, and project-specific sidecar
requirements are not established release-one requirements. Revisit them
explicitly if the initial consumer projects need them.

## 8. Configuration, persistence, and observability

### What belongs in Git

The consumer repository holds versioned project policy, role/agent definitions,
skills, non-secret configuration, and durable project decisions. Shared
configuration may reference account IDs; runtime accounts remain in the database.
The Cerebra repository holds application schema/migrations and installation
templates.

Machine capacity, enabled local agents, ports, and credential provisioning are
local concerns. Password hashes, session tokens, provider logins, API keys, live
database files, and operational state must not be committed to source control.

The separate application database is another logical database on the existing
Dolt service, not another database server. Dolt's own versioned data history is
not the same as committing a live database directory into the source repository.
Sensitive account/session data needs an explicit retention treatment so database
versioning does not unintentionally preserve it indefinitely.

### Release-one persistence

Persist the current:

- Work packages, acceptance criteria, dependencies, rank, ownership, and status.
- Decisions needed to complete work, pending questions, and approvals.
- Latest execution checkpoint and branch/PR/workflow references.
- Accounts, assignments, configuration, and instance identity.
- Compact per-package timestamps and counters for execution, human waiting,
  review rework, and recovery.

No Cerebra historical event archive, persisted full chat/terminal transcripts, or
automated backup/restore feature is required. Beads/Dolt and GitHub may retain
their native history. Detailed local diagnostic output is supplementary, not the
recovery source of truth.

Acknowledged durable state must survive a process restart. Permanent storage
loss may lose data: there is no release-one recovery-point or disaster-recovery
guarantee without separately operated backups. Cloning the source repository
does not restore the installation's accounts or active work.

### Operator controls and metrics

Expose local agents and assignments; role attention queues; active, waiting, and
stuck states; CPU/RAM; retry/crash state; and pause/drain/stop controls. Distinguish
occupied human-wait slots from agents actively making progress.

Use compact work-package data for shared project throughput, cycle time, human
wait duration, review rework, and recovery counters. Do not introduce an event
warehouse to satisfy these initial metrics.

Show provider usage/cost when available and explicitly mark missing values as
unknown, not zero. CPU/RAM are the intended future capacity constraints.
Human-role bottlenecks should be visible; adding agents is not automatically a
solution to a human approval backlog.

Automatic scaling later uses already-enrolled machines only. It must preserve
the manual fleet and decision semantics unless those requirements are changed.

## 9. Feasibility gates and implementation sequence

Complete these gates before treating the stack as a verified implementation plan.
They are technical experiments, not permission to install the whole stack as
part of this documentation task.

| Gate | Required evidence | If it fails |
| --- | --- | --- |
| Provider session integration | For each provider, real CLI tools/skills, permitted subscription auth in a Linux container, streaming structured chat, and interactive terminal on the same live session; input arbitration and disconnect/reconnect behavior | Return to the product decision; do not replace the session, scrape a terminal into fake chat, or silently use API billing |
| Shared Beads coordination | Concurrent clients on two machines; one winning claim; same-owner idempotency without duplicate execution; persistent machine ownership; conditional stale-owner rejection; contention-safe merge coordination and explicit rank | Seek supported Beads mechanisms or a narrow upstream extension; otherwise evaluate another existing tracker against the same contract |
| Application storage | Shared accounts/roles and application migrations on a separate Dolt database; needed transactional/conditional-update semantics; sensitive-data treatment; no Beads schema changes | Revisit application storage explicitly rather than introducing another server unnoticed |
| Container/worktree execution | Isolation on macOS and Linux, safe Git metadata access, provider login provisioning, resource observation, and sleep/crash/restart recovery | Adjust isolation/packaging before pilot use |

Beads priority levels alone do not implement a fully ordered backlog. Determine
and test a supported metadata/ranking representation. Likewise, the documented
claim and merge-slot commands are starting points, not proof of the complete
reassignment, fencing, or cross-operation transaction contract.

After the gates pass, implement a thin vertical slice: one project, two instances,
human-ranked work, implementation, independent GitHub review, a human question
answered through the owning UI, merge, and human-triggered deployment. Then add
the complete role inbox, crash/stuck recovery, external issue intake, and the
20-execution load scenario. Enterprise deployment is a later readiness phase.

## 10. First-release acceptance criteria

| Area | Observable outcome |
| --- | --- |
| End-to-end delivery | Demonstrate idea clarification, human ranking, implementation, independent review, configured verification, and human-triggered successful deployment |
| External intake | Repeatedly poll an external GitHub report without duplicating its internal work package; humans control urgency/rank |
| Concurrency | Run 20 active agent executions over two machines when runnable work exists; both machines contribute to one project |
| Exclusive ownership | Contention tests have exactly one successful owner per package and zero duplicate execution authorizations |
| Recovery | Crash/restart an engine and agent without losing acknowledged work decisions; recover on the owning machine and stop automatic recovery after its bound |
| Offline ownership | Sleep/disconnect a worker without another worker automatically taking its packages; prohibit new offline claims |
| Reassignment | Explicit reassignment makes the previous claim stale and prevents its subsequent authoritative Cerebra updates |
| Human interaction | Streaming chat and browser terminal address the same live session; role questions are answerable only through the owning instance |
| Human wait | Waiting preserves the slot/session without triggering stuck detection; unrelated agents continue |
| Review | A distinct agent session reviews; findings appear on GitHub; configured human reviews also happen on GitHub |
| Policy | Applicable checkpoints precede controlled merge/deployment; disclose cooperative enforcement rather than claiming bypass prevention |
| Isolation | Agent commands run inside the intended container boundary without host Docker socket or broad home access |
| Observability | Show active work, human waiting, reviews/rework, recovery, CPU/RAM, and known/unknown usage data |
| Persistence scope | Restart preserves current state; do not imply full transcript replay or disaster recovery |

No numeric throughput improvement, acceptable defect rate, UI latency target,
or per-agent resource budget was agreed during the interview. Establish those
baselines using representative consumer-project work before claiming improved
throughput or quality. Twenty concurrent agents is a capacity target, not evidence
of increased accepted throughput.

## 11. Open implementation questions

These are not silently settled by the technology selection:

- Which supported provider interfaces satisfy the exact same-session dual UI and
  subscription requirements, and under what account/organization constraints?
- Which supported Beads operations cover fencing, atomic transitions, ordered
  ranking, and merge-slot recovery without editing its schema?
- Which Dolt-compatible driver/migration approach should application storage use?
- How should authenticated session data be stored without unwanted versioned
  retention, and what is the local-account bootstrap/reset procedure?
- What progress signals distinguish a stuck agent from a valid long command,
  and when is a recovery incident considered resolved?
- How are configuration revisions adopted consistently across independent
  engines while work is already in progress?
- How should GitHub side effects be reconciled after an ambiguous timeout so a
  retry does not duplicate an issue comment or deployment?
- What resource sizes, workload, and quality baseline represent the initial pilot?

## 12. Sources and evidence limits

The following upstream documentation was consulted on 2026-09-21. These are
moving sources; pin and recheck relevant versions during the feasibility work.
No provider execution, concurrency benchmark, or integration spike was performed
as part of this interview.

- [Cerebra README](../README.md): initial expansion goals.
- [Cerebro](https://github.com/rmstdope/cerebro): predecessor workflow and implementation.
- [Beads README](https://github.com/steveyegge/beads/blob/main/README.md):
  work model, claims, storage modes, and structured CLI.
- [Beads Dolt backend](https://github.com/steveyegge/beads/blob/main/docs/architecture/dolt.md):
  server mode, external connection configuration, and version compatibility.
- [Beads coordination](https://github.com/steveyegge/beads/blob/main/docs/multi-agent/coordination.md):
  atomic/idempotent claims and merge slots.
- [Beads update reference](https://github.com/steveyegge/beads/blob/main/docs/cli-reference/update.md)
  and [merge-slot reference](https://github.com/steveyegge/beads/blob/main/docs/cli-reference/merge-slot.md):
  supported metadata and coordination interfaces.
- [Copilot SDK](https://github.com/github/copilot-sdk):
  CLI-server JSON-RPC architecture, tools/skills, and authentication methods.
- [Claude Code authentication](https://code.claude.com/docs/en/authentication):
  subscription and container login flows.
- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview):
  runtime features and third-party authentication restrictions.
- [node-pty](https://github.com/microsoft/node-pty):
  PTY support and process-permission cautions.
- [xterm.js](https://github.com/xtermjs/xterm.js): browser terminal component.
