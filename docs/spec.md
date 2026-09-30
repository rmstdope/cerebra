# Cerebra: specification

**Status:** draft 1, 2026-09-28. Written with the navigator by interview; every choice behind it
is logged in `decisions.md` (D*n*). New to this project? Read `background.md` first: it explains
the system this one replaces, which these documents call *classic Cerebro*.

This document says what the system does and for whom. How it is built is `architecture.md`.

## 1. What Cerebra is

Cerebra runs a fleet of AI coding agents against a project's GitHub repository and puts one
person, the **navigator**, in charge of it through a web UI. The navigator decides what is worth
doing and in what order, agrees with a design agent what a person will see, and verifies the
result; agents build, review and merge everything in between. Cerebra's job is to make that
division of labour explicit: at every moment each work item is in exactly one state, held by at
most one agent, and anything waiting on the navigator is in one place.

What carries over from classic Cerebro is the fleet: named agents with fixed roles, the stages a
piece of work passes through, and the rule that nothing merges red or unreviewed. Almost
everything around it is new: containers instead of a shared checkout, a database instead of
labels on beads, a web UI instead of a terminal view, and agents that are defined and started by
configuration rather than by a roster file and a supervisor process.

### Goals

- **Unambiguous work.** One state field per work item, one holder at most, one fixed lifecycle.
- **Contained agents.** Each agent run is a rootless container that can reach only what its role
  needs: its checkout, the backend's tools, the secrets its type declares.
- **Agents as conversations.** The navigator sees and talks to an agent as a structured chat, not
  a terminal.
- **Configurable fleet.** Agent types are defined once, overridden per project, and started by
  work arriving in a state or by a schedule.
- **Two agent backends.** Claude and GitHub Copilot in v1; the MVP runs Claude only (§14).

### Non-goals for v1

- More than one navigator (the boundary exists, the second user does not; D1).
- Forges other than GitHub (D12).
- Projects that are not git repositories.
- Running agents anywhere but the machine the main container is on.
- A terminal UI of any kind (D4).
- Reviewing pull requests from outside the fleet (D24).
- Restricting agents' network access (D22).

## 2. Concepts

| Term | Meaning |
|---|---|
| **Instance** | One running Cerebra: a main container, its database, and the agent containers it starts. |
| **Navigator** | The person operating the instance. Ranks, answers, approves at checkpoints and verifies. |
| **Project** | A GitHub repository registered with the instance, with its own settings, board and fleet. |
| **Work item** | One unit of work on a project's board: a feature, bug, task or refactoring. |
| **State** | The single field that says where a work item is in the lifecycle (§4). |
| **Agent type** | A definition of a role: instructions, backend, model, tools, secrets, triggers (§5). |
| **Agent** | A named instance of an agent type in a project, e.g. *Storm*, a producer. |
| **Run** | One execution of an agent in its own container, usually holding one work item. |
| **Trigger** | What starts a run: work in a state, a schedule, or the navigator. |
| **Secret** | A named value (a token, a key) an agent type may be given at run time (§7). |

## 3. Projects

A project is registered from a GitHub remote URL. Registering clones it into the instance, reads
its default branch, sets its key prefix, and creates the project's agents from the instance's
default agent types (§5.2).

A project's settings:

- **Stages.** Whether the *grooming*, *design* and *verify* stages are on (all on by default).
  Build, review and merge are always on.
- **Involvement.** How much of the builders' work the navigator approves, as a preset of
  checkpoints (§4.9). *Autonomous* by default. Under `full`, the project also names the GitHub
  account whose review counts (D33).
- **Application paths.** Which paths a person using the product can see; a merge that touches none
  of them skips verification.
- **Limits.** Maximum concurrent runs in the project (the instance also has a ceiling; §5.4); `max_attempts` (default 3) and `max_rounds`
  (default 5), which escalate an item to the navigator (§4.5).
- **Project instructions.** Text every agent in the project is given after its type's own
  instructions: what the project is, how to build and test it, the traps it has paid for. The
  repository's own `CLAUDE.md` / `AGENTS.md` are read by the agents as usual; project instructions
  are for what those files do not say.
- **Agent image.** Built from the repository's `.cerebro/agent.Containerfile` when there is one,
  so agents build and test with the project's own toolchain (D19).
- **Automation paused.** Stops every trigger-started run in the project; runs already going and
  runs the navigator starts are unaffected.

## 4. Work items and their lifecycle

### 4.1 Fields

| Field | Meaning |
|---|---|
| `key` | The project's key prefix and a number, `cb-42`. Never reused. The prefix is set when the project is registered (proposed from the repository's name) and cannot change once the first item exists. |
| `title`, `description` | What and why, as filed. A title alone is enough; grooming fills in the rest. |
| `type` | `feature`, `bug`, `task` or `refactoring`. Chosen when filed; routes a `bug` to the bugfixer (§5.3). |
| `priority` | P0–P3. Empty while the item is `new`; set by the navigator at triage. |
| `filed_by`, `source` | Who filed it (the navigator, or a run) and where it came from (a GitHub issue, a parent, the run that discovered it). |
| `state` | Exactly one of the states in §4.2. |
| `holder` | The run holding the item. Set in a working state and in no other (§4.3). |
| `waiting_kind`, `waiting_reason`, `return_state` | Set in `waiting` and in no other state: what kind of wait it is (`question`, `escalation`, `code_review`, `merge`), why, in words, and the state the item returns to. |
| `parent` | The item this one is a child of, if any. Nesting has no depth limit (D15). |
| `dependencies` | `blocks` (the other item must be done first), `related`, `discovered_from`. |
| `labels` | Free tags for the navigator. **No label changes routing, ever.** |
| `records` | The structured outputs of each stage: the outcome, the agreed experience, the build plan, the pull request, review verdicts, the verification verdict (§4.11). Appended, never overwritten. |
| `involvement` | The item's own involvement preset, when the navigator set one at triage; otherwise the project's applies (§4.9). |
| `attempts`, `rounds` | Escalation counters (§4.5). |
| `comments`, `history` | Discussion, and every state change with its actor and reason. |

An item with an unfinished `blocks` dependency is **blocked**. Blocked is not a state: it is shown
on the item and makes it unclaimable, and nothing else.

### 4.2 States

Every stage has a queue state, where the item waits for an agent, and a working state, where an
agent holds it (D7).

| State | Kind | Holder | Meaning |
|---|---|---|---|
| `new` | navigator queue | — | Filed, not yet triaged. |
| `grooming_ready` | queue | — | Worth doing; waits for a groomer to agree its outcome. |
| `grooming` | working | groomer run | A groomer is agreeing with the navigator what the item is meant to achieve. |
| `design_ready` | queue | — | Needs an agreed experience; waits for a designer. |
| `designing` | working | designer run | A designer is agreeing the experience with the navigator. |
| `build_ready` | queue | — | Ready to build; waits for a producer (a bugfixer if it is a bug). |
| `building` | working | builder run | A builder is planning, implementing and opening the pull request. |
| `review_ready` | queue | — | A pull request is open; waits for a reviewer. |
| `reviewing` | working | reviewer run | A reviewer is reviewing the pull request. |
| `merging` | system | — | Approved; the backend merges it once its checks are green. |
| `verify_ready` | queue | — | Merged; waits for a verifier. |
| `verifying` | working | verifier run | A verifier is verifying it with the navigator. |
| `waiting` | navigator queue | — | Stopped on the navigator. Carries a reason and the state to return to. |
| `split` | parent | — | Has children; waits for them (§4.6). |
| `done` | terminal | — | Finished. |
| `cancelled` | terminal | — | Will not be done. |

A **stage** is a queue state and its working state together: *grooming* (`grooming_ready`,
`grooming`), *design*, *build*, *review*, *verify*, and *merge* (`merging` alone). `new`,
`waiting`, `split`, `done` and `cancelled` belong to no stage. The project's **stage switches**
(§3) turn the grooming, design and verify stages on or off.

### 4.3 Invariants

1. An item has exactly one state.
2. An item has a holder if and only if its state is a working state, and that holder is a live run
   (§6.1).
3. An item has `waiting_kind`, `waiting_reason` and `return_state` if and only if it is `waiting`.
4. Only a transition in §4.4 changes a state, and each names who may make it.
5. An item in `new` has no priority; an item in any other state except `cancelled` has one. (An
   item cancelled at triage may never have been ranked; an override back to `new` clears it.)
6. An item with children is `split`, `done` or `cancelled`.

The lifecycle engine enforces all six. The database also refuses a row that breaks 1, 3, 5 or
the first half of 2 (a holder exactly in working states); that the holder is live, and invariant 6,
span several rows and are the engine's alone.

### 4.4 Transitions

| From | To | By | When |
|---|---|---|---|
| `new` | `grooming_ready`, `design_ready`, `build_ready`, `split`, `cancelled` | navigator | Triage (§4.10): priority set and route chosen. A route to a stage that is off is refused. |
| `grooming` | `design_ready`, `build_ready` | groomer | The outcome is agreed and recorded, and the navigator confirmed the route the groomer proposed. |
| `grooming` | `split` | groomer | As above, and the navigator confirmed splitting it; the children are filed in the same step (§4.6). |
| `grooming` | `cancelled` | groomer | The navigator decided, in grooming, that it is not worth doing. |
| `*_ready` | the matching working state | backend, for a run | The run claims the item (§5.4). |
| `designing` | `build_ready` | designer | The experience is agreed and recorded. |
| `building` | `review_ready` | builder | The plan is recorded, the builder's latest checks passed, and the pull request is open in the project's repository on a branch named after the item's key (the key, or the key and `-`), its link recorded. |
| `building` | `design_ready` | builder | The agreed experience cannot be built as written; the reason is recorded. |
| `reviewing` | `merging` | reviewer | Approved. Under the `code_review` checkpoint the engine sends it to `waiting` instead (below). |
| `reviewing` | `build_ready` | reviewer | Changes requested, with at least one blocking finding; `rounds` +1. The review record names the revision reviewed. |
| `merging` | `verify_ready` | backend | Merged, the verify stage is on and the change touches application paths. |
| `merging` | `done` | backend | Merged, otherwise. |
| `merging` | `waiting` | backend | A block (§4.5): a required check failed, the branch conflicts with the default branch, the pull request changed since the approved revision, or GitHub refused the merge (including a pull request closed without merging). The block is recorded; `return_state` `merging`. |
| `verifying` | `done` | verifier | Passed. A follow-up, if any, is filed as a new item. |
| `verifying` | `build_ready` | verifier | Failed, the build at fault. Priority becomes P0. |
| `verifying` | `design_ready` | verifier | Failed, the agreed experience at fault. Priority becomes P0. |
| any working state | its queue state | backend | The holding run ended without moving the item; `attempts` +1 (§4.5). |
| any non-terminal state | `waiting` | agent holding it, backend | Something only the navigator can decide; reason recorded. |
| `waiting` | `return_state`, or any state the navigator picks | navigator | Answered. A block is answered on the item: *send back to the builder* (`build_ready`, the same pull request continued) or *return to design* (`design_ready`, with a reason; the pull request is closed with it). |
| `waiting` (code review) | `merging` | backend | The navigator approved the pull request on GitHub (§4.9). |
| `waiting` (code review) | `build_ready` | backend | The navigator requested changes on GitHub; `rounds` +1. |
| `done` | `build_ready`, `design_ready` | navigator | Reopened. Closed is not terminal for the navigator. |
| any state | `cancelled` | navigator | Dropped. |
| any state | any state | navigator | Override, recorded with a reason. The invariants still hold. |

A **checkpoint** (§4.9) is where the flow stops for the navigator's approval as part of normal
work rather than because something went wrong. The engine applies the item's checkpoints itself,
so no agent has to know them: a move into `merging` becomes a move into `waiting` with
`waiting_kind` `code_review` (when the reviewer approved and that checkpoint is on) or `merge` (when
only that checkpoint is on), and `return_state` `merging` either way. An item leaving a
`code_review` wait to `merging` then stops again if the `merge` checkpoint is also on.

A transition to a state the project has switched off, or to `split` while nesting is not yet
built (the MVP, §14), is refused by the engine.

### 4.5 When a run ends, and escalation

- **When a run ends** holding an item in a working state — it crashed, the navigator ended it, or
  it finished without moving the item — the backend moves the item back to its queue state and adds
  one to `attempts`, with the run's last assistant message as a comment. A run that is only
  *parked* (§6.1: `idle`, its container stopped while it waits) has not ended and keeps its item.
- **`attempts`** counts claims since the item last moved to a different stage (`waiting` is no
  stage, so a wait keeps the count). When it reaches the project's `max_attempts`, the item goes
  to `waiting` instead of back to its queue; for a builder that is the block *too many attempts*.
- **`rounds`** counts reviews that requested changes since the item last left `waiting`. A request
  that would reach `max_rounds` goes to `waiting` instead, as the block *too many rounds*.
- **A block** is a wait the backend records because the work cannot go on without the navigator:
  a required check failed, a merge conflict, changes since approval, GitHub refusing the merge
  (in GitHub's own words, or because the pull request was closed without merging), too many
  rounds, or too many attempts. The item's Overview shows it with the navigator's two answers, *send back to the
  builder* and *return to design*; the queue row opens the item. The merge never goes around a
  block: nothing merges red, and nothing merges that was not the approved revision.

### 4.6 Parents

An item gets children in one of two ways: the navigator splits it at triage, or a groomer splits
it at the end of grooming with the navigator's confirmation. Either way it moves to `split` and its
children are filed in the same step. Children of a groomer's split skip triage (D35): they inherit
the parent's priority and go straight to the route agreed for each (`design_ready` or
`build_ready`), since the navigator has just agreed them. Children of a split at triage start in
`new` like any other item. No other role splits an item; a follow-up an agent discovers while
working is filed as a new item with a `discovered_from` link. Only items without children pass
through the build stages. When the last child of a `split` item is `done` or `cancelled`, the parent moves
to `verify_ready` if the verify stage is on and any child touched application paths, so the family
is verified as a whole, and to `done` otherwise. A child of a family that will be verified as a
whole skips its own verification (D23).

### 4.7 The navigator's queue

Everything that waits on the navigator, in every project, appears in one list: items in `new`
(to triage), items in `waiting`, and runs that are waiting for an answer in their chat (§6.2). Nothing else
needs the navigator, and nothing that needs the navigator is anywhere else. Non-blocking notices
(the *informed* checkpoint) go to a separate feed and never into this queue.

### 4.8 Notifications

Only what blocks on the navigator interrupts them; everything else waits in the UI until they look
(D40).

| Event | Delivered as |
|---|---|
| A run asks a question (`awaiting_input`), the `plan` checkpoint included | push |
| An item enters `waiting`: a question, an escalation, the `code_review` or `merge` checkpoint | push |
| Something is wrong with the instance or a project: a missing credential, the board mirror failing to push, a project image failing to build | push |
| Items arriving in `new` | the queue's count only |
| `informed` notices: a plan written, a pull request opened or merged, a release made | the feed only |

**Channels.** Always, in the app: the navigator queue's count, the same count in the browser tab's
title, and the feed, all live. By default, a browser notification for every push while any Cerebra
tab is open; clicking it opens the item or the run. Optionally, one outbound webhook: a JSON POST
per push to a URL the navigator sets (ntfy, Pushover, a Slack incoming webhook), which is how a
push reaches their phone when they are away from the machine.

**Rules.** A push is sent once, when the item or run enters the waiting condition; there are no
reminders. Pushes arriving within 30 seconds of each other are sent as one. No push is sent for a
run whose chat the navigator has open and in focus. A project can be muted, which stops its pushes
and nothing else.

### 4.9 The navigator's involvement

How closely the navigator follows the builders is configurable, from builders running entirely on
their own to the navigator approving every design decision and the final code (D32). It is built
from four checkpoints:

| Checkpoint | Where | What the navigator does |
|---|---|---|
| `informed` | builder opens its plan; a pull request opens or merges | Nothing is waiting: a notice in the feed links the plan or the pull request. |
| `plan` | `building`, after the plan is written, before the first line of code | Approves or amends the builder's plan: files to change, the public surface of anything new, the increments, and every decision the builder made that the agreed experience left open. The builder submits its plan with `submit_plan`, which blocks in its chat until the navigator answers, so it keeps the item and its context (§6.2). The engine refuses `building → review_ready` for an item with no plan record, or, under this checkpoint, with no approved one. |
| `code_review` | after the reviewer agent approves | Reviews the pull request on GitHub (D33). The item waits in `waiting` (code review); the backend reads the navigator's GitHub review and moves the item to `merging` on an approval or back to `build_ready` on requested changes, whose comments the next builder run is given. |
| `merge` | entering `merging` | Says when to merge, without re-reviewing. The item waits in `waiting` (merge); the answer returns it to `merging`. |

Presets name the usual combinations:

| Preset | Checkpoints |
|---|---|
| `autonomous` | none |
| `informed` | `informed` |
| `plan` | `informed`, `plan` |
| `full` | `informed`, `plan`, `code_review` |

A project picks a preset and may add `merge` to any of them. At triage the navigator can set a
different preset on one item, raising or lowering the project's. Bugfixer runs follow the same
rules as producer runs. The reviewer agent's review always happens; `code_review` adds the
navigator's on top of it, never instead of it.

### 4.10 Filing, triage and grooming

**Filing.** Every item enters the board in `new`, without a priority, whoever files it:

| Route | Filed by | `source` |
|---|---|---|
| Quick-add on the board, or the item form | navigator | — |
| A conversation with the assistant | assistant run, for the navigator | the run |
| A follow-up discovered while working | the working run | `discovered_from` the item it held |
| A verifier's follow-up to a passed verification | verifier run | `discovered_from` the verified item |
| The architect's sweep | architect run | the commits it swept |
| A new GitHub issue | inbox run | the issue |

Two exceptions: children of a groomer's split (§4.6), and the bulk paths — the one-time beads
importer (§13) and a restore from the board branch (§11) — which keep the state an item already
had.

**Triage** is the navigator's, on the board (D14): keep or drop the item, set its priority, and
choose where it goes next — normally `grooming_ready`; straight to `design_ready` or `build_ready`
when it is already clear what it is for (a well-written bug report, a refactoring the architect
filed with its reasoning); `split` when it is plainly several items; or `cancelled`.

**Grooming** makes sure the navigator and the fleet share an understanding of what an item is
meant to achieve before anyone designs or builds it (D34). A groomer reads the item, the code and
related items, then interviews the navigator until the item carries an **outcome record**:

- **Problem**: what is wrong or missing today, and why it matters now.
- **Who benefits**, and how.
- **Outcome**: what will be true when the item is done, as observable results — never as screens,
  layouts or wording, which are the designer's.
- **Out of scope**: what the item deliberately does not do.
- **How we will know**: what the verifier (or the navigator) will check to call it achieved.

The groomer ends by proposing a route — design, build, or a split into children with a route for
each — and the navigator confirms or changes it in the chat before the groomer makes the
transition. Every later stage works against the outcome record: the designer designs for it, the
builder and reviewer check the pull request against it, the verifier verifies it.

A project that switches the grooming stage off routes from triage straight to design or build, and
its items carry no outcome record.

### 4.11 Records

Each stage leaves a record on the item, the structured output the next stage works from. A record
is Markdown under fixed `##` headings, spelled exactly, every heading present; one that does not
apply says **None.** and why. Records are appended: a stage that runs again writes a new version,
and the earlier ones stay in the item's history. The headings below are carried over from classic
Cerebro, where they were tuned against real use (`background.md`).

**Outcome** — written by the groomer (§4.10).

```markdown
## Problem
## Who benefits
## Outcome
## Out of scope
## How we will know
## Route
```

*Route* is the route the navigator confirmed: design, build, or the children of a split with a
route for each.

**Design** — written by the designer when the experience is agreed.

```markdown
## The agreed experience
## The states
## The words, exactly
## What was considered and rejected
## The mockup
```

*The states* covers every state a person can meet, empty and error included; *The words, exactly*
quotes every label, heading and message as it will ship; *The mockup* names the chosen mockup,
which is kept with the record (§6.4). An item with nothing a person can see skips design at
triage or grooming and has no design record.

**Plan** — written by the builder before its first line of code, through `submit_plan`, and the
subject of the `plan` checkpoint (§4.9).

```markdown
## Context
## Files to change, and what to reuse
## Increments
## The test plan
## User-facing decisions
### Agreed with the navigator
### Decided by me
## Out of scope
## Validation
## Known traps
```

*Files to change* carries the design of the code: the public surface of anything new, where state
lives and who owns it. *Increments* are small and ordered, each naming the failing test that opens
it. *Agreed with the navigator* points at the design record rather than paraphrasing it; *Decided by
me* lists, one line each, every detail the builder decided inside the agreed shape — the navigator
can overrule any of them. *Validation* is the exact commands that prove the outcome.

**Checks** — written by the builder through `report_checks` each time it runs the project's
checks: whether they passed, and a one-line summary. The latest report must have passed before the
item goes to review; the Overview's delivery activity shows every report.

**Pull request** — written by the builder when it hands the item to review: the pull request's URL,
its branch, the head commit it asks to have reviewed, and its title.

**Review** — written by the reviewer: a verdict (`approved` or `changes_requested`) and its
findings, each with a severity (`blocking` or `advisory`), the file and line it concerns, and what
is wrong. `approved` means no blocking finding is left. The reviewer checks the pull request
against the plan, the design record and the outcome record, and that it carries the tests the plan
promised.

**Verification** (v1, §14) — written by the verifier: a verdict (`passed`, `failed_build`,
`failed_design`), what was checked against *How we will know*, and for a failure what was seen.

## 5. Agents

### 5.1 Agent types

An agent type is defined once for the instance and used in each project, where it can be
overridden field by field; a field a project has not overridden follows the instance's default.
A project can also define types of its own. Types and overrides are edited in the web UI, and
every save is a revision that can be compared and restored (D27). A run records the revision it
started with.

| Field | Meaning |
|---|---|
| `name`, `role` | Its name, and which of the built-in roles (§5.3) it plays, if any. |
| `backend` | `claude` or `copilot`. |
| `model`, `effort` | The model and reasoning effort it runs on. |
| `instructions` | Its role instructions. The project's instructions are appended after them. |
| `skills` | The skills its runs are given (§5.5). |
| `interactive` | Whether its runs are conversations with the navigator. Any agent may ask a question (D18); an interactive one is started to talk. |
| `serves` | The queue states it takes work from, and optionally which item types. |
| `triggers` | How its runs start (§5.4). |
| `tools` | Which of the backend's tools (§6.3) it may call, and which built-in tools of its backend. |
| `secrets` | Which secrets it is given (§7). |
| `image`, `resources` | Container image, and CPU/memory limits. |
| `network` | Which destinations it may reach beyond the backend. Unrestricted in v1 (D22). |
| `idle_timeout` | How long a run may sit with no activity before it is stopped. |

### 5.2 Agents

An agent is a named instance of a type in a project: Cyclops, Storm, Wolverine and Rogue are
producers. A project's agents are listed on its fleet page, each showing its current run, what it
holds and its state. An agent keeps its own home and CLI state across runs, so it has a memory of
the project, and has at most one live run at a time; the number of enabled agents of a type is how
many runs of that type can go at once (D17). An agent is **free** when it is enabled and has no
live run.

Each default agent type carries a default number of agents and a list of names to give them; the
defaults reuse classic Cerebro's names where a role carries over (`background.md`). Registering a
project creates that many agents of each type: one each of groomer, designer, bugfixer, reviewer and
assistant, and two producers (and one each of verifier, architect and inbox in v1). The navigator
renames, adds, disables and removes agents on the fleet page.

### 5.3 Built-in roles

The instance ships a default agent type for each role (D26). Their instructions are written for
this system, not copied: classic Cerebro's role definitions are the source to port from, since they
record how each role was tuned against real use, but everything in them about labels, state files,
worktrees, scripts and the terminal view is replaced by the tools of §6.3 (`background.md` lists
which classic file each role comes from).

| Role | Serves | Started by | Job |
|---|---|---|---|
| groomer | `grooming_ready` | state | Agrees with the navigator what the item is meant to achieve, records the outcome, and proposes its route. Never designs what a person sees. |
| designer | `design_ready` | state | Agrees with the navigator what a person will see, with mockups, and records it. |
| producer | `build_ready`, not bugs | state | Plans, implements test-first and opens the pull request. |
| bugfixer | `build_ready`, bugs | state | Reproduces with a failing test, fixes, opens the pull request. |
| reviewer | `review_ready` | state | Reviews the pull request against the item's records; approves or sends back. |
| verifier | `verify_ready` | state | Prepares the verification and walks the navigator through it. |
| assistant | — | navigator | A conversation in a project: files items, proposes rankings, answers questions about the board, and makes a release when asked (§9). |
| architect | — | schedule | Sweeps recent merges for technical debt and files refactoring items into `new`. |
| inbox | — | schedule | Turns new GitHub issues into `new` items and keeps each issue's status in step with its item. |

### 5.4 Triggers

- **State.** When an item the type serves is in a queue state, unblocked and unheld, and one of
  the type's agents is free, the backend starts a run of that agent and claims the item for it in
  the same step. Within a project, items are offered highest priority first, then oldest. Each
  project has its own run limit and the instance has a ceiling over all of them; between projects
  there is no ranking, the item that became claimable first is started first (D30). Limits hold
  trigger-started runs back; a run the navigator starts is never held back.
- **Schedule.** A five-field cron expression, read in UTC. A tick fires once and is never caught
  up: a tick missed while the instance was down, or refused by a limit, is skipped.
- **Navigator.** The navigator can start any agent from the fleet page, optionally for a given
  item, which it then claims regardless of the type's `serves`.

### 5.5 Skills

A skill is a named, self-contained procedure (a `SKILL.md` and any files beside it) that an agent
loads when its task calls for it (D37). An agent type lists the skills its runs are given, from two
sources:

- **Instance skills**, stored and edited like agent types (D27): seeded from the skills shipped in
  the image, revised in the UI.
- **Project skills**, in the project's repository under `.cerebro/skills/<name>/`, read from the
  run's own checkout, so they are versioned with the code. A project skill replaces an instance
  skill of the same name.

The release skill (§9) is the first project skill. The repository's own agent configuration
(`.claude/`, `AGENTS.md`, `.github/agents/`) is still discovered by the backends as usual; Cerebra
neither copies nor overrides it.

## 6. Runs and conversations

### 6.1 A run

A run is one container executing one agent, usually holding one work item. Its states:

| State | Meaning |
|---|---|
| `starting` | Its checkout and container are being made. |
| `active` | The agent is working. |
| `awaiting_input` | The agent asked the navigator something, or an interactive run finished a turn and waits for the navigator's next message; the container is still up. |
| `idle` | *Parked*: it has waited longer than its type's idle timeout, so its container was stopped. Its conversation is kept and the next message from the navigator resumes it in a new container. Any run can be parked, not only an interactive one (D18). |
| `finished`, `failed` | Ended: it completed, was ended by the navigator, or crashed. |

A run is **live** in every state but `finished` and `failed`. A live run keeps the item it holds,
parked or not; only an ended run gives it back (§4.5). In the MVP runs are never parked: a run
waiting for the navigator keeps its container up for as long as it waits (§14).

**A run's first message** is generated by the backend from the item it holds: its key, type and title,
the records so far, and — when the item came back — why: the review findings, the failing checks or
conflicting paths, the navigator's requested changes, or the verification verdict. A message the
navigator typed when starting the run follows it.

Every run is recorded: its full event history, what it held, cost and tokens, its branch and pull
request. A finished run is kept for inspection until deleted.

### 6.2 The chat view

Every run is shown as a chat: the agent's messages, its tool calls and their results (diffs shown
as diffs), sub-agents nested under the call that spawned them, and a composer for the navigator's
messages, which may be sent at any time, mid-turn included. A question the agent asks is shown as
a form with its options and a free-text answer, and the run waits in `awaiting_input` until it is
answered. Opening a chat later shows everything that happened while nobody watched.

An agent asks a free question with its own backend's question tool (Claude's `AskUserQuestion`,
Copilot's user-input request), which the runner turns into the form; there is no separate Cerebra
tool for it. The two structured questions — a plan for approval (`submit_plan`) and mockups to
choose between (`show_mockups`) — are backend tools, because the backend records what was decided.

### 6.3 What an agent can do to the board

Agents never write the database. They call the backend's tools, and the backend checks every call
against the lifecycle and the calling run's type:

| Tool | Does |
|---|---|
| `get_item`, `list_items` | Read items, their records and comments. `get_item` without an id reads the held item. |
| `transition` | Move the held item along a transition its role may make (§4.4), with the record that transition requires. A groomer's move to `design_ready` or `build_ready` is also checked against the outcome question the navigator answered in its conversation: the route must be the one they chose and the record's five sections the ones they confirmed, or nothing moves. A designer's move to `build_ready` is checked the same way against the confirmation of the agreed experience it asked: the navigator must have confirmed it, and the record's sections must be the ones they confirmed. |
| `wait_for_navigator` | Move the held item to `waiting` with a reason. |
| `comment` | Comment on an item. |
| `create_item` | File a new item into `new` (§4.10). A groomer files the children of its split through `transition` instead. |
| `submit_plan` | Record the builder's plan (§4.11). Under the `plan` checkpoint it also shows the plan to the navigator and returns only with their answer: approved, or what to amend. Builders only. |
| `report_checks` | Record whether the builder's latest run of the project's checks passed (§4.11). Builders only. |
| `record_release` | Record a release the run has made (§9). Assistant only. |
| `show_mockups` | Publish mockups from the run's checkout and ask the navigator to choose between them (§6.4); the round is recorded in the conversation and returns only with the navigator's choice or written change. Designer only. |

### 6.4 Mockups

The designer agrees what a person will see by showing the navigator mockups, not by describing
them (D42). A mockup is a self-contained HTML page — or an image — the designer writes in its
checkout. `show_mockups` publishes one or more of them to the backend and puts a question in the
chat whose options are the mockups themselves: each is rendered beside the question, can be opened
full size, and is chosen, or answered with what to change. Rounds of mockups stay in the chat's
history, so the navigator can go back to an earlier one.

When the experience is agreed, the chosen mockup is kept with the item as part of the design
record, next to the written experience, and is what the builder, reviewer and verifier see. A
mockup is shown isolated from Cerebra's own page: it can run its own scripts, but cannot reach the
UI's session, the API or the network.

## 7. Secrets

A secret is a named value, entered once and never shown again. It has a scope, most specific
winning:

1. **Instance**: every project.
2. **Project**: one project.
3. **Agent type**: one agent type, instance-wide or in one project.

An agent type declares which secrets it is given, by name, and how (environment variable or file).
Two kinds are special:

- **Model credential**: what the type's backend authenticates with (a Claude subscription token, a
  GitHub token with Copilot access). Every run gets the most specific one for its backend without
  declaring it. For Claude that is the navigator's subscription token (D20).
- **Agent GitHub token**: what a run pushes, opens pull requests and posts reviews with. A project
  secret given to the types that push, to the reviewer, and to the assistant for releases.
- **Project GitHub token**: what the backend itself uses for the project — fetching the mirror,
  merging, reading pull requests, checks and reviews, pushing the board branch. Never given to a
  run. It may hold the same value as the agent token; it is kept apart so that it can be stronger
  (a token with merge rights) without every agent holding it.

The UI lists names, scopes, when each was last used and by which run, never values.

## 8. GitHub

- **Pushing.** A builder run commits in its checkout, pushes a branch named after its item and
  opens a pull request, all with its agent GitHub token (§7). Every commit carries a `Work-Item: cb-42`
  trailer and the pull request names the item, so the code leads back to the work.
- **Navigator reviews.** Under the `code_review` checkpoint the navigator reviews on GitHub, and
  the backend reads the review of the project's review account (D33).
- **Reviews.** The reviewer posts its review on the pull request as a comment with its agent
  GitHub token, and records its verdict, the revision it reviewed, the review's link and its
  findings on the item.
- **Merging.** The backend watches pull requests in `merging` and squash-merges each through the
  GitHub API, pinned to the approved revision, once every check on it has passed, then deletes the
  branch. A failed check, a conflict, or a head that moved since approval blocks it instead
  (§4.5).
- **Issues.** The inbox agent reads and comments on issues with its own token.
- **Rework.** An item sent back to `build_ready` keeps its branch and pull request; the next
  builder run continues them, starting from the first message of §6.1 (D25). When an item goes
  back to `design_ready`, the backend closes its pull request with a comment saying why, and the
  next build starts a new one.
- **External pull requests.** Not in v1 (D24).

## 9. Releases

A release is made by the assistant when the navigator asks for one, by following the project's
**release skill** (D36): how this project versions, what it builds, what it tags and publishes.
The skill lives in the project's repository at `.cerebro/skills/release/SKILL.md`, versioned with
the code it releases; Cerebra ships a template to start from. A project without one cannot be
released through Cerebra, and the assistant says so.

When the release is made, the assistant records it with `record_release` (version, tag, commit).
The backend completes the **release record** (D38) with every `done` item whose merge is contained
in that commit and in no earlier release. The record is what the home page's *shipped since the
last release* is measured against, and what the inbox uses to tell each linked GitHub issue that
its work has been released.

The assistant type is given the GitHub token it needs to push a tag and publish a release, and a
checkout of the default branch, like any other run.

## 10. Costs

Every run records what it consumed (D39): tokens by kind (input, output, cache read, cache write)
and model, and the cost its backend reports — a dollar figure for Claude, premium requests for
Copilot. Sub-agents' consumption is part of the run that spawned them. Under a subscription the
dollar figure is what the same usage would cost at API prices, not what was billed, and the UI says
so; it is still the right measure for comparing one piece of work with another.

A run's cost belongs to the work item it held, or to no item if it held none. That attribution is
all the reporting needs:

| View | Shows |
|---|---|
| **Project** | Total for the project, split into work-item costs and costs with no item. |
| **Work item** | Total for the item, and for a parent the total of its whole family beside its own. |
| **Work item, by agent** | The item's total broken down by agent and by stage (grooming, design, build, review, verify), including every attempt and round. |
| **Not tied to an item** | Runs that held no item — the assistant's conversations, the architect's sweeps, the inbox, runs the navigator started without an item — by agent type and by agent. |

Every view can be narrowed to a period, and a view across all projects adds them up. The totals
are sums over runs, so they stay right when an item is reopened, split or re-parented later.

## 11. The board in the repository

Each project's board is mirrored into its own repository, on an orphan branch `cerebro/board` that
shares no history with the code (D31):

- one Markdown file per item, `items/cb-42.md`: its fields as front matter, then its description,
  records and comments;
- written by the backend only, committed in batches (at most one commit a minute, naming the items
  it changed) and pushed with the project's token;
- never read back while the database is healthy: the database is the truth and the branch is
  derived from it.

It gives the board version history and diffs next to the code, and an off-machine copy. A project's
board can be **restored** from the branch into an empty project, which is also how a project moves
to another instance. Runs, their transcripts and secrets are not mirrored; they are covered by the
database backups (architecture, *Backups*).

## 12. The web UI

The experience must feel **Modern, Stylish, Easy** (D45): simple to navigate and operate, with
powerful controls available when needed, following web conventions. Light and dark themes are
present from the first application UI; the initial theme follows the system preference, and a
persistent Light/Dark/System choice lets the navigator override it. Accessibility targets
WCAG 2.2 AA, including keyboard access, screen-reader labels, visible focus, sufficient contrast
and reduced-motion support.

On first use, the navigator chooses a password, registers a GitHub repository and configures its
credentials, then reaches an empty board with a clear way to file the first item. Returning visits
open the cross-project navigator queue. Errors are explicit, never rendered as empty results;
history, cancellation, reopening and reasoned overrides support correcting mistakes. Detailed
screens and wording are agreed with the navigator in UX sessions.

The navigator works on several projects at once from one instance and one browser tab (D2):

- **Home**: the navigator queue across every project (§4.7), active runs, and what merged recently.
- **Board**: a project's items by state, with filters; triage (rank and route) on `new` items.
- **Item**: fields, records, comments, history, and the runs that touched it. From `build_ready`
  on, its Overview shows the delivery activity — plan, checks and pull request, oldest first, then
  what happens now — beside an at-a-glance summary.
- **Fleet**: a project's agents, each with its current run; start and stop.
- **Run**: the chat view (§6.2), plus the run's branch, diff and cost.
- **Costs**: the views of §10, per project and across projects; an item's own cost is also on its page.
- **Settings**: project settings (§3), agent types (§5.1), secrets (§7).

## 13. Migration

An importer reads an existing beads board and files every open bead as a work item, mapping
each bead's status, priority and labels onto one state (for example `human` → `waiting`, `ux:agreed`
→ `build_ready`, closed without a verification → `verify_ready`). Closed beads are imported as
`done` for history. The importer runs once per project and refuses a project whose board is not
empty.

## 14. The MVP

The first delivery is the smallest system on which the new repository's own development can run:
an item goes from `new` through grooming, design, build, review and merge, with the navigator in
the chat (D41). Everything else in this document is v1, and is designed now so that adding it does
not change what the MVP built.

**In the MVP**

- The pod (main container and Postgres), rootless agent containers, the two networks.
- The runner with the `claude` adapter; the runner protocol; the chat view with questions as forms,
  messages mid-run, and mockups (§6.4).
- The whole lifecycle (§4.2–4.5), its invariants as database constraints, and the stage switches.
- Triage, the navigator's queue, and filing by quick-add and by agents.
- State triggers, per-project and instance limits, named agents with their memory.
- The agents' board tools, the git mirror and per-run checkouts, agents pushing and opening pull
  requests, merge by rule on green checks, the `Work-Item:` trailer.
- Secrets at instance and project scope, with the model credential and the GitHub token.
- Roles: groomer, designer, producer, bugfixer, reviewer, assistant.
- Involvement per project, with the `plan` and `code_review` checkpoints.
- Usage recorded for every run; cost shown per run and per item.
- One user with a password; in-app counts and browser notifications; light/dark/system themes
  and the accessibility requirements of §12 from the first application UI.
- A scheduled `pg_dump`.

**Postponed to v1**

| Postponed | What the MVP does instead |
|---|---|
| The `copilot` backend | `claude` only; the runner's adapter interface is in place. |
| The verify stage and the verifier | Stage off: merged items go to `done`. |
| Nesting, splitting, `split` and family verification | No hierarchy; the engine refuses `split`. A groomer that finds several items agrees one of them as this item's outcome and files the others with `create_item` into `new`, linked `discovered_from`, for triage. |
| Schedule triggers, the architect and the inbox | Navigator and state triggers only. |
| Releases and release records | None. |
| Instance skills in the database | Project skills from `.cerebro/skills/` only, copied in by the runner. |
| Revisions of agent types | Types seeded from files and edited in a plain form. |
| The board mirror branch and restore | The database dump only. |
| The cost views of §10 | Cost per run and per item. |
| The webhook, the feed, the `informed` and `merge` checkpoints, per-item involvement | In-app counts and browser notifications; `plan` and `code_review` per project. The presets are `autonomous`, `plan` and `full`, with `informed` ignored. |
| Project images built from `.cerebro/agent.Containerfile` | The base image, or an image named in the project's settings. |
| Surviving a backend restart: the runner's event spool, reconnect, stopping idle containers | A restart fails live runs, whose items go back to their queues. |
| The beads importer | The new repository starts with an empty board. |

**Order of delivery** is `roadmap.md`, steps 4 to 8.
