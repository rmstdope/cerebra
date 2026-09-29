# cr-r0m — retrospective

- **Implementer:** Storm
- **Date:** 2026-09-29
- **PR:** #46

## Removing a serial-test workaround turned the gate red on unrelated tests

**What happened.** The schema fix went green alone. Deleting `fileParallelism: false` from `vitest.config.mts`, as the bead's exit condition asked, then turned `pnpm run check` red on unrelated tests:
- Database, Podman-wrapper (`scripts/test-database.test.mjs`) and UI tests hit vitest's 5 s timeout.
- `app.test.tsx` matched two "Which release should…" buttons.

The machine's load average was 45–60 on 18 cores from other sessions. Serial runs passed. A 4-worker cap still failed.
**Why.** The serial run had hidden timing faults. With files in parallel on a busy machine, spawning processes and migrating schemas take longer than 5 s. The UI lookup was unscoped, so it matched a second copy once the board rendered, which only happens when rendering is slow.
**Cost.** About 30 minutes and five extra full-gate runs, before a single `testTimeout: 30_000` and a scoped query fixed it. main (#45) made the same UI fix in parallel.
**Prevent by.** When a bead adds a test-isolation workaround such as `fileParallelism: false` or `--no-file-parallelism`, put the gate's timing under parallel files in the removal bead's plan from the start. Check a new `vitest.config.mts` setting under parallel load before the plan relies on it.
**Seen before.** none found.
