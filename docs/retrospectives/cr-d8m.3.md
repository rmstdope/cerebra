# cr-d8m.3 — retrospective

- **Implementer:** Rogue
- **Date:** 2026-09-29
- **PR:** #51

## A UI focus test failed in the full gate and passed alone

**What happened.** The first `pnpm run check` on this backend-only change failed one test outside the
diff: `packages/ui/src/conversation-page.test.tsx` › "a new conversation invites the first message
with the composer focused". `npx vitest run packages/ui/src/conversation-page.test.tsx` then passed
3/3, and a second full `pnpm run check` was green, as was CI.
**Why.** Not established. The test reads `document.activeElement` synchronously right after its
first `findByRole`, not inside `waitFor`, and it failed only while the whole gate ran in parallel.
**Cost.** One extra full gate run (~5 minutes) and the time to rule the failure out as this PR's.
**Prevent by.** Make the focus assertion in that test wait for focus
(`await waitFor(() => expect(document.activeElement).toBe(…))`), or establish that focus is set in
the render the `findBy…` already awaited.
**Seen before.** none found
