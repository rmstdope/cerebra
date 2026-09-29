# cr-edk.1 — retrospective

- **Implementer:** Cyclops
- **Date:** 2026-09-29
- **PR:** #38

## CI never started, and `gh pr checks` only said "no checks reported"

**What happened.** After review answers were pushed, `gh pr checks 38` printed "no checks
reported on the 'cr-edk.1' branch" for more than ten minutes, and `gh run list --branch cr-edk.1`
listed no runs at all, not even for the first push. `gh pr view 38 --json mergeStateStatus` was
`UNKNOWN`. cr-edk.2 and cr-edk.3 had merged to main while the bead was being built, and a local
`git merge origin/main` then showed conflicts in seven files (main.ts, server.ts, index.ts,
database.ts, database.test.ts, app.tsx, app.test.tsx).
**Why.** GitHub does not run `pull_request` workflows on a pull request that cannot be merged, so a
conflicting PR shows no checks rather than a failure. The fleet migration
(`20260929020000_create_fleet`) also sorted before main's `20260929030000_create_credentials`; an
instance already migrated to main would have refused it, so it was renamed to `20260929040000`.
**Cost.** About twelve minutes of polling, a seven-file conflict resolution and one extra gate run.
**Prevent by.** In produce-bead *Red CI* / the CI wait, treat "no checks reported" plus a
non-`CLEAN` `mergeStateStatus` as a conflict and merge main at once; and before opening the PR,
fetch main and check that the bead's migration timestamps sort after every migration on main.
**Seen before.** none found.

## `git stash` during an unfinished merge dropped the merge

**What happened.** With conflicts resolved and staged but not yet committed, `git stash` /
`git stash pop` (to rerun one test against main's version) removed `MERGE_HEAD` and unstaged the
index; a plain `git commit` would have recorded a single-parent commit and hidden main's history.
It was recovered with `git write-tree` and `git commit-tree -p HEAD -p origin/main`.
**Why.** `git stash` saves and resets the working tree and index but does not keep an in-progress
merge's state.
**Cost.** About five minutes of checking that no content from main was lost.
**Prevent by.** Commit the merge before any experiment, and compare against main with
`git show origin/main:<path>` or a separate worktree instead of stashing.
**Seen before.** none found.
