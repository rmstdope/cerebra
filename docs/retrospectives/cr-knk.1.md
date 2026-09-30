# cr-knk.1 — retrospective

- **Implementer:** Rogue
- **Date:** 2026-09-30
- **PR:** #68

## Two different CI-only flakes used up both bare re-runs on one unchanged commit

**What happened.** CI's `check` on 7c4f99b (run 36694638977) failed three times, twice on tests outside the diff; `e2e` was green each time.
- First run: two tests in `packages/backend/src/supervisor.test.ts` ("a completed result finishes the run…" and "a run told to finish ends finished when its turn ends…") got `expected 'starting' to be 'finished'`.
- First re-run: `packages/ui/src/conversation-page.test.tsx` › "each step is a line between messages…" failed instead.
- Second re-run: green.

The supervisor file passed 3/3 alone and 6/6 in parallel on macOS. It also passed with its `settle()` wait cut from 20 to 2 iterations, so its failure could not be reproduced locally. The same supervisor test had failed CI on the cr-cq8.2 and cr-cq8.3 branches, and the conversation-page file had failed on `main` (a2f54f4, af1681e).

**Why.** Not established. Both failures depend on load on the CI runner. The supervisor tests assert after a fixed `settle()` (20 × 5 ms), and shortening it did not reproduce the failure, so the fixed wait alone is not the cause.

**Cost.** Two red CI runs, the bead's whole bare re-run budget, and about 20 minutes ruling both out. One more flake would have handed a green change back to a person.

**Prevent by.** The fixes cr-c4f.2 and cr-cq8.3 already proposed: have `supervisor.test.ts` wait on the run's state (`vi.waitFor`) rather than on `settle()`, and make `conversation-page.test.tsx`'s assertions wait. Until then, *Red CI* in `produce-bead` could count a re-run on a failure already recorded in `docs/retrospectives/` as a known flake, not against the budget.

**Seen before.** cr-c4f.2 (the supervisor tests, `expected 'starting' …`), cr-cq8.3, cr-axc and cr-d8m.3 (`conversation-page.test.tsx`).
