# Release 0.1 implementation decisions and evidence

This records autonomous decisions made while implementing the first release on
2026-09-22. The product baseline remains
[product-and-architecture.md](product-and-architecture.md).

## Decisions made without another interview

| Topic | Decision and reason |
| --- | --- |
| Same-session provider integration | Keep the actual interactive CLI as the only agent process. Claude's documented `MessageDisplay`/lifecycle hooks and Copilot's documented `joinSession` extension provide structured events. Chat input is bracketed-paste input to that same PTY; it never creates a parallel SDK session or parses ANSI into messages. |
| Input arbitration | One browser holds terminal input at a time. While it does, custom chat input is disabled. Chat accepts a new prompt only while the provider is idle. Human answers are durable first and delivered when input is available. |
| Work authority | Beads server mode only. Require `--if-assignee`/`--if-status`, use unique assignment tokens, and reject embedded databases. Register the Beads project/database/branch identity across instances. |
| Work representation | Titles and acceptance criteria use native Beads fields; child packages use native parent links. Cerebra's workflow phase, strict rank, execution dependencies, questions, and evidence live in namespaced metadata. Beads open/in-progress/closed status is synchronized, but `bd ready` is not Cerebra's scheduler. |
| Cross-operation coordination | Dolt `GET_LOCK` on the application service serializes work mutations, overlapping-path claims, and merge/deployment operations across engines. Guarded Beads writes independently reject stale assignment owners. Never expire work claims because a laptop disappears. |
| Merge slot choice | Use a shared Dolt named lock rather than adding a second ownership record or relying on an unverified Beads merge-slot recovery procedure. Beads remains the only work ownership authority. |
| Sensitive application tables | `cerebra_users` and `cerebra_sessions` are untracked ignored Dolt tables: durable in the working set but excluded from normal Dolt commits. This is not encryption or a promise against an administrator force-adding them. Do not force-add these tables. |
| Accounts and roles | Passwords use salted scrypt; only hashes of random browser-session tokens are stored. Sessions expire after 12 hours. CLI administration creates accounts, changes project role assignments, and resets passwords with session revocation. |
| Instance identity | A persistent per-instance machine identity plus a local PID lock prevents accidental duplicate instance IDs. A new machine gets a new instance ID; a human releases lost-machine work explicitly. |
| Multiple consumer projects | Run one engine configuration per project per machine, with distinct instance IDs, ports, and data directories. Accounts may share the application database; role assignments stay project-specific. An aggregated multi-project UI is not assumed for the first release. |
| Configuration revisions | Shared project policy is hashed, excluding machine-local checkout paths. Mismatched engines stop scheduling and controlled external actions. An operator explicitly adopts revised policy and restarts engines. |
| Task filesystem | Each work package gets a private bare clone and one worktree. Only that task root is mounted at its original absolute path, preserving Git metadata without exposing the consumer checkout or other tasks. Exact task paths are Git safe-directory exceptions for VM-backed mounts; no wildcard exception is used. |
| Agent credentials | Dedicated agent homes persist provider-native login state. `cerebra login` opens an isolated shell for supported provider/gh login. No host credential extraction or broad home-directory mounts. Optional installer-provisioned credential files are scoped per agent. |
| Direct conversations | A human may start a conversation with an idle local agent before creating ranked delivery work. This is a pinned conversation work package, not a backdoor to ranking delivery work. The agent proposes unranked work and completes the conversation explicitly. |
| Decomposition | A ranked delivery package can become an epic with ordered child packages and dependencies. Children inherit human rank; agents choose their local order. Epics do not count as additional delivered changes. |
| Overlap avoidance | `data.paths` declares relative file/directory prefixes; `*` means the whole repository. Known overlapping scopes are serialized. Empty scopes mean unspecified, not proven disjoint, so planning should supply scopes. Dynamic file discovery still needs conflict resolution. |
| Reviews | Reviewers receive a distinct work assignment/session. Findings are idempotently published as GitHub PR comments with commit markers. They are not mislabeled as a GitHub human approval. |
| Human review vs verification | Required human code review is GitHub's review decision. Optional feature verification is a distinct Cerebra decision attached to the reviewed head. |
| Additional quality gates | Projects declare named checkpoints, optionally requiring a human role. Evidence is tied to the current PR head; missing, failed, or stale gates prevent controlled merge. Unknown configuration keys are rejected rather than silently ignored. |
| Deployment | The human authorizes the merged commit. Dispatch the workflow from the default branch with `cerebra_commit` and `cerebra_request_id` inputs; the workflow checks out the authorized commit. Its run name includes the request UUID for reconciliation. |
| Ambiguous external effects | Persist dispatch intent before invoking gh. An ambiguous result becomes uncertain and is reconciled, never blindly redispatched. GitHub has no general exactly-once dispatch guarantee. |
| Recovery | Three automatic retries per incident. A changed durable checkpoint after at least 60 healthy seconds clears the incident budget; starting a process alone does not. Human waits never time out. Tool executions have a separate configurable six-hour timeout. |
| Observed usage | Copilot structured usage events contribute known token counts and nano-AIU costs, with explicit unpriced request counts. Missing Claude/other-provider usage stays unknown; no dollar or credit conversion is invented. |
| Runtime startup | A provider bridge that is not ready after two minutes becomes visibly blocked; the terminal remains available for login/trust setup. No silent model/authentication fallback. |
| Streaming load | Ephemeral provider events authenticate against the current local execution token without a Beads subprocess per token delta. Durable work mutations still recheck shared ownership; scheduler reconciliation retires stale executions. This also keeps local observation usable during a shared-store outage. |
| Pause / drain / stop | Pause prevents new assignments and automatic external actions but leaves live sessions alone. Drain continues already-owned work, child work, reviews, merges, and requested deployments without taking new top-level work. Stop terminates local executions and retains claims/checkpoints. |
| Live terminal buffer | Keep a bounded in-memory terminal tail, with sequence numbers, for browser reconnection/view switching. It is not persisted transcript history. Chat messages are also live browser state, not an archive. |
| Testing without credentials | Deterministic runtimes and GitHub fixtures are test-only. Production configuration never selects an in-memory work store or fake provider. Tests do not claim model inference or production deployment occurred. |

## Evidence collected so far

- TypeScript server/core/browser type checks and production build.
- Domain, policy, authenticated API, recovery, independent-review, deployment
  intent/reconciliation, and input-arbitration tests.
- Browser scenarios for login, work creation/ranking, human answers, streaming
  chat, terminal control, pause/resume, and logout.
- Real Dolt named locks, account/session persistence, ignored sensitive tables,
  and Beads create/claim/update/release operations.
- A real Dolt process restart retaining all recorded account rows, including
  ignored sensitive tables, plus password-reset session revocation.
- Twenty competing claims with exactly one winning assignment per item.
- Independent macOS and Linux-VM engine processes each filling ten slots from
  the same real Beads backlog, with no duplicate assignments. Agent executions
  in this particular test are deterministic fixtures.
- A real Linux agent image containing Claude Code 2.1.278 and Copilot CLI 1.0.86.
- Actual container PTY input/output and resize; non-root execution; dropped
  capabilities; no Docker socket; writable task/home mounts; host/container Git
  worktree compatibility.
- Both real provider CLIs starting in isolated unauthenticated homes, rendering
  in their terminals, and reaching the assignment-authenticated local bridge.
  Task files survive container replacement; scoped bridge files are removed
  when executions stop.
- The compiled production CLI creating accounts, starting both real listeners,
  authenticating a browser session, and releasing its PID lock on shutdown,
  including a termination signal during startup.
- Checked-in Claude hook and Copilot extension scripts exercised against
  structured protocol fixtures. This does not substitute for authenticated
  provider sessions.
- Pinned Linux Beads 1.3.0 downloaded with release checksum verification and
  exercised against the same server as the installed macOS Beads build.

Tests are executable evidence, not a blanket release-readiness certification.
Consult the commands in [operator-guide.md](operator-guide.md).

### Final local verification

| Check | Result |
| --- | --- |
| `pnpm check` | Type checks, 48 unit/API/workflow/bridge tests, and production build passed |
| `pnpm test:e2e` | 3 browser scenarios passed |
| `pnpm test:integration` | 4 real Beads/Dolt tests passed in an automatically created and cleaned fixture |
| `pnpm test:docker` | 3 real-container tests passed, including both provider startup paths |
| Compiled CLI smoke | Real database, account login, web assets, and shutdown passed |
| macOS/Linux distributed fixture | Both engines filled 10 slots; all 20 assignments were unique |
| `pnpm audit` | No known advisories reported for the final dependency lockfile |

The Docker and compiled-CLI checks used the dedicated
`colima-cerebra-release` Docker context, not a changed global default. Docker and
Colima were installed because the initial environment lacked a container
runtime. The verification VM is stopped after testing; its built
`cerebra-agent:local` image remains available in that profile. Temporary database
fixtures and downloaded test binaries are removed. No production service is
left running, and no remote GitHub changes are made.

## Remaining live-environment release gates

The following require installer-provided accounts and an explicitly configured
consumer repository. Do not report them as passed merely because fixture tests pass:

1. Authenticate both dedicated provider homes using supported subscription
   login flows. Confirm applicable provider account/organization policies.
2. For **each provider**, demonstrate structured assistant streaming, user
   messages, terminal interaction, and chat input on the exact same running
   session, including a human wait and a browser reconnect.
3. Run a representative consumer change through real implementation, GitHub
   review, optional human verification, merge, and a human-authorized successful
   deployment workflow.
4. Run 20 simultaneous **real provider** executions on the intended hardware and
   subscription accounts. The cross-OS coordination test proves scheduling and
   exclusivity, not provider quota availability or sustainable hardware capacity.
5. Establish throughput/quality baselines with representative work. Concurrency
   alone is not evidence of improved throughput.

The isolated provider homes available during implementation were unauthenticated.
No login tokens were extracted from the host, no customer code was sent to a
model as a test, and no real consumer merge or deployment was initiated.

## Known scope limits

Approvals are cooperative, as agreed. Broad agent GitHub credentials can bypass
the harness; Docker does not enforce GitHub approval authority. No enterprise
authorization, public-hosting design, backup feature, durable chat archive,
automatic scaling, cloud workers, or production monitoring is included.

Named locks coordinate cooperating Cerebra engines, not arbitrary external Beads
writers. Directly editing Cerebra-owned metadata with another tool can bypass
workflow rules. Use the Cerebra API/CLI for active work and coordinate database
maintenance with stopped engines.
