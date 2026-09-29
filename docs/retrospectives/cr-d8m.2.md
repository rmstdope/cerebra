# cr-d8m.2 — retrospective

- **Implementer:** Wolverine
- **Date:** 2026-09-29
- **PR:** #53

## The gate's classification step refuses to run in this repository

**What happened.** `produce-bead` *Building* says to classify the change before the gate with
`git diff --name-only -z origin/main...HEAD | xargs -0 .cerebro/cerebro/scripts/build-workload --classify`.
In this repository it exits 3, printing
`build-workload: no rust_paths in .cerebro/project.conf - cannot classify safely.`, so there was
no classification to compare with the plan's `disk-preflight --workload non-rust`. I ran the
declared gate (`pnpm run check`, which is both `gate_fast` and `gate_full`) without it.
**Why.** `.cerebro/project.conf` declares no `rust_paths`, and `build-workload`
(`.cerebro/cerebro/scripts/build-workload:10`) treats that as an error, not as "nothing is Rust".
This is a TypeScript-only project.
**Cost.** A few minutes spent reading the script and deciding that going on was safe. There was
no gate re-run.
**Prevent by.** Either declare an explicit empty or never-matching `rust_paths` in
`.cerebro/project.conf` for this TypeScript project, or have `build-workload --classify` answer
`non-rust` when `rust_paths` is absent. Otherwise every producer here hits the same refusal.
**Seen before.** none found
