# cr-edk.3 — retrospective

- **Implementer:** Rogue
- **Date:** 2026-09-29
- **PR:** #37

## A dialog opened from a dropdown-menu item lost focus as soon as it opened

**What happened.** On the Credentials page, choosing "Change" or "Remove" from the Manage menu
(shadcn `DropdownMenu`, Radix underneath) opened a dialog. The dialog's first control briefly had
focus, then `document.activeElement` went back to the Manage trigger. The keyboard tests in
`packages/ui/src/credentials-page.test.tsx` failed intermittently, and neither `autoFocus` nor
focusing in `onSelect` fixed it.

**Why.** When the Radix menu closes, its FocusScope returns focus to the trigger in a `setTimeout`,
which runs after anything the item's `onSelect` did. The fix was to store the chosen action in a
ref, run it from the menu Content's `onCloseAutoFocus` (calling `preventDefault()`), move dialog
focus in an effect, and assert focus in tests with `waitFor`.

**Cost.** About an hour and several test iterations inside increment 7.

**Prevent by.** A note in `docs/architecture.md`, in the UI section that covers shadcn/Radix
conventions: "a menu item that opens a dialog runs its action from `onCloseAutoFocus`, not from
`onSelect`". Or a shared `MenuItem`-opens-dialog helper in `packages/ui` that does it once.

**Seen before.** None found.
