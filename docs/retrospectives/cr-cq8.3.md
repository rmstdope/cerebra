# cr-cq8.3 — retrospective

- **Implementer:** Rogue
- **Date:** 2026-09-30
- **PR:** #66

## CI's `check` went red on two conversation-page tests the bead never touched

**What happened.** After both review rounds, CI run 36675440201 failed `check` on two existing tests
in `packages/ui/src/conversation-page.test.tsx`: "a question is a focused form…" and "each step is
a line…". `e2e` passed. The local gate had been green. Running that one file eight times in
parallel (`xargs -P 8`) failed intermittently, on the branch and on `main` alike; on `main` seven
unrelated tests failed per run. `main`'s own CI has failed in the same file before (run
36659224546). A bare re-run of the failed job went green with the commit unchanged.
**Why.** Not established beyond "load-dependent": the failing assertions are about focus and form
rendering. They only fail when the file shares the machine with other work.
**Cost.** One CI cycle, one of the bead's two bare re-runs, and about 20 minutes spent reproducing
it and ruling out the bead's changes.
**Prevent by.** A bead that makes the focus and waiting assertions in
`packages/ui/src/conversation-page.test.tsx` robust under parallel load, checked with the same
`xargs -P 8` loop on `main`. Until then, *Red CI* in `produce-bead` could say that a failure
confined to this file, and reproducible on `main`, is a known flake.
**Seen before.** cr-c4f.2 (UI tests failed under fleet load; CI tests passed on a re-run of the
same commit), cr-r0m (UI tests timing out under parallel files).

## A preToolUse hook refused shell commands mentioning image file extensions

**What happened.** Writing the plan with `bd update --design "…"` was refused before running
because the text named drawing types by their dotted extensions (the JPEG, PNG and similar ones).
The plan had to go through a file written with the editor tool and `bd update --design-file`.
**Why.** A hook matches command text against a list of file extensions, whatever the command
does with them.
**Cost.** A few minutes and a rewrite of the command.
**Prevent by.** `produce-bead`'s *The plan* says to always use `--design-file` with a file written
by the editor tool, never inline text; or the hook matches paths being read, not arbitrary text.
**Seen before.** cr-edk.6 (the same refusal for the text `.key`).
