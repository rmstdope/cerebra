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
mine" by name, so it needed the new predecessor too.
**Why.** Each producer picks the next timestamp after the newest migration on main when it plans.
Two beads planned from the same main pick the same one, and nothing checks for it before the rebase.
**Cost.** One conflict resolution, a rename commit, and a rerun of the database suites and the
full gate.
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
