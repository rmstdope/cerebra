# cr-edk.6 — retrospective

- **Implementer:** Storm
- **Date:** 2026-09-29
- **PR:** #49

## Shell commands containing the text `.key` are refused before they run

**What happened.** The session's preToolUse hook refused every bash command whose text contained
`.key` (for example a React `item.key`, or a `grep` pattern with `\.key` in it). The refusal
was "matches globally-ignored file type '*.key'", even though no `*.key` file was involved. Edits
by python heredoc and searches with `grep -rli "\.key…"` over `docs/retrospectives/` were all
refused. The work had to be redone with the edit tool and the built-in grep tool instead.
**Why.** The hook matches the ignored-extension pattern against the whole command string, not
against the paths the command touches.
**Cost.** A few retries and minutes. No CI cycles.
**Prevent by.** A line in `.cerebro/traps.md`: on this host, keep the literal `.key` out of bash
command text. Use the edit/create tools for source edits and the built-in grep for searches.
**Seen before.** None found.
