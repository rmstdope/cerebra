# cr-axc: retrospective

## The composer-focus test failed in CI and alone, not only under the parallel gate

**What happened.** The first CI run on PR #61 failed one test outside the diff:
`packages/ui/src/conversation-page.test.tsx` › "a new conversation invites the first message with
the composer focused". It failed on `expected <body> to be <textarea>`. The same test failed once in
eight runs of that single file on macOS, with no other suites running. A bare re-run of CI was green.
**Why.** Not established. The test is the one cr-d8m.3 named. It reads `document.activeElement`
synchronously after its first `findByRole`, so focus can arrive a tick later than the assertion.
This run shows the race does not need the whole gate running in parallel.
**Cost.** One red CI run, one of the bead's two bare re-runs, and about five minutes spent ruling it
out as this PR's.
**Prevent by.** The fix cr-d8m.3 proposed:
`await waitFor(() => expect(document.activeElement).toBe(…))` at
`packages/ui/src/conversation-page.test.tsx:130`. It has now cost two beads.
**Seen before.** `docs/retrospectives/cr-d8m.3.md`, "A UI focus test failed in the full gate and
passed alone".
