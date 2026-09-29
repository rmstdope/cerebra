# cr-c4f.2 — retrospective

- **Implementer:** Rogue
- **Date:** 2026-10-04
- **PR:** #58

## Two beads built in parallel both added a migration named `20261004000000_…`

**What happened.** The rebase onto main before review conflicted in
`packages/backend/src/database.test.ts`, which lists every applied migration. main (cr-c4f.1, #56)
had added `20261004000000_add_builder_delivery`, and this bead had added
`20261004000000_record_usage`: the same timestamp. Kysely's `FileMigrationProvider` orders by the
whole file name, so the tie was broken by the suffix alone. An instance already migrated to main
would have refused this bead's migration as out of order. It was renamed to
`20261005000000_record_usage`. This bead's backfill test also migrated to "the migration before
mine" by name, so it needed the new predecessor too. After review and CI, main (cr-c4f.3, #57)
added `20261005000000_add_backups`, the same tie a second time. The PR went `CONFLICTING`, and
the migration was renamed again, to `20261006000000_record_usage`.
**Why.** Each producer picks the next timestamp after the newest migration on main when it plans.
Two beads planned from the same main pick the same one, and nothing checks for it before the rebase.
**Cost.** Two conflict resolutions and two renames, each followed by the database suites, a
full gate and a CI run.
**Prevent by.** In produce-bead's step before opening the PR (or in the gate), fail when a
migration added on the branch does not sort strictly after every migration on
`origin/<default branch>`. Alternatively, have migration names carry the bead id after a
timestamp that includes the time of day, so two parallel beads cannot tie.
**Seen before.** cr-edk.1 (a bead's migration sorted before one main had added meanwhile).

## The full gate failed 9 UI tests under fleet load, then passed unchanged

**What happened.** The first `pnpm run check` failed 9 tests in 4 files. Among them was
`packages/ui/src/project-board.test.tsx` `openItem`, where `findByRole` timed out after its default
1 s. The load average was about 92 at that moment (`uptime`: 44 / 92 / 59). The same command,
rerun with no change, passed: 68 files, 791 tests. CI passed too.
**Why.** Not established in detail. Testing Library's `findBy…` has a 1 s default timeout,
independent of vitest's `testTimeout: 30_000`, and it expired while the machine was saturated by
other sessions.
**Cost.** One extra full gate run (about 4 minutes) and the time to rule the failures out as this
PR's.
**Prevent by.** Raise Testing Library's `asyncUtilTimeout` in `packages/ui/src/test-setup.ts`
(`configure({ asyncUtilTimeout: 10_000 })`), as `vitest.config.mts` already did for `testTimeout`.
**Seen before.** cr-r0m, cr-d8m.3.

## Two supervisor tests failed in CI and passed on a rerun of the same commit

**What happened.** CI on 338ef3c (run 36608082196) failed two tests in
`packages/backend/src/supervisor.test.ts`. "records events in order, follows the runner's status
and tells subscribers" got `expected 'starting' to be 'active'`. "a failed result or a runner that
goes away without one fails the run" did not reach `state: 'failed'`. Nothing in `supervisor.ts`
or its test changed since the last green CI on 79f41f8. The file passed 3/3 locally, and
`gh run rerun --failed` on the same commit passed. main's own CI (run 36606757267) failed the same
hour on an unrelated UI test.
**Why.** Not established. Both assertions read a run's state after the fake runner's events,
which looks timing-dependent on a busy runner.
**Cost.** One extra CI cycle (about 3 minutes) and the time to rule out the merge.
**Prevent by.** Have those two assertions in `supervisor.test.ts` wait for the state
(`await vi.waitFor(...)`) rather than read it once after the events.
**Seen before.** cr-d8m.3 (a test outside the diff failed once in the gate and passed alone).
