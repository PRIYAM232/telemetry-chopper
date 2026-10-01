# Feature 8: Safe rule delete (confirm and undo)

**Status:** Shipped, 2026-10-01 · **PR:** _pending_ · **Issue:** [#12](https://github.com/PRIYAM232/telemetry-chopper/issues/12)

## Summary

**Delete** used to remove a rule immediately: no confirmation, no undo, nothing on screen to say it happened, and the button sat right beside **Pause** on every card. One stray click could remove, for example, a PII-redaction rule, and the PII would reach the log vendor on the collector's next poll.

Now:
- **Delete asks first.** A dialog names the rule and explains what happens. For an active rule it offers **Pause instead**, the reversible alternative.
- **Delete can be undone.** A toast reports *Deleted rule "name"* with an **Undo** button. Undo brings the rule back with the same ID, settings, position and per-rule history.
- **Delete is set apart.** A divider separates it from Pause on each card.

## Using it

1. Click **Delete** on a rule card. The dialog opens with focus on **Cancel**, so pressing Enter or Esc never deletes.
2. Choose one:
   - **Cancel**: nothing changes.
   - **Pause instead** (active rules only): pauses the rule and closes the dialog.
   - **Delete rule**: the card disappears and collectors stop enforcing the rule on their next policy poll, as before.
3. The toast stays for 15 seconds. **Undo** restores the rule; collectors pick it up again on their next poll.

## How it works

Delete is a **soft delete**. `PolicyRule.deletedAt` is set, and every place that serves rules filters it out:
- the policy API (`deletedAt` is also left out of the JSON, so the wire format and the ETag of an unchanged ruleset don't change);
- the dashboard's rule list;
- Pause/Resume.

**Undo** clears `deletedAt` within a **60-second** server-side window. That is longer than the toast, so a slow click still works.

**Purging:** rules deleted more than 60 seconds ago are permanently removed, along with their per-rule history, on the next delete or undo. Undo purges first, so *"Too late to undo: the rule was permanently deleted"* is always true when shown.

Because a restored rule keeps its ID, the collector reuses its per-rule counters (Feature 6) rather than starting new ones.

## What changed

| File | Change |
|---|---|
| `prisma/schema.prisma` + migration `20261001004315_rule_soft_delete` | `PolicyRule.deletedAt DateTime?` |
| `src/app/api/v1/policies/[fleetId]/route.ts` | Serves live rules only; omits `deletedAt` |
| `src/app/dashboard/actions.ts` | `deleteRule(ruleId)` soft-deletes and returns the name; new `restoreRule(ruleId)`; purge of expired deletes; Pause/Resume ignores deleted rules |
| `src/app/dashboard/rule-delete.tsx` (new) | `DeleteRuleButton` (modal `<dialog>`) and `RuleToaster` (polite live region with Undo) |
| `src/app/dashboard/page.tsx` | Hides soft-deleted rules; Delete opens the dialog; divider between Pause and Delete; one toaster per page |

## Limitations

- A rule deleted from one browser can't be undone from another; the Undo button lives in the toast of the browser that deleted it.
- If nothing is deleted or undone after a rule's window closes, its row stays (hidden) until the next delete or undo purges it.
- Delete now needs JavaScript. Without it the button does nothing, which is the safe failure.

## Verification

Browser tests against a dev server and a scratch Postgres, with the database checked after each step:
- **Opening the dialog:** it is modal, names the rule, and starts with focus on Cancel. Pressing **Enter** closes it and the rule survives. **Esc** also closes it.
- **Pause instead:** the rule is paused (`isActive=false`), the dialog closes, and nothing is deleted. A paused rule's dialog offers only Cancel and Delete rule.
- **Delete rule:** the card disappears and the toast reads *Deleted rule "drop-healthcheck-noise"*. The row has `deletedAt` set, and the policy API no longer serves the rule (and has no `deletedAt` key).
- **Undo:** the toast reads *Restored rule…*, and the rule comes back in its original position with the same ID.
- **Undo after the window** (`deletedAt` backdated 61 s): the toast reads *Too late to undo…* and the row is gone from the database. Testing this caught a bug: the first version said "permanently deleted" before actually purging.
- **Purging a stale delete:** a delete purged an older expired one.
- **Layout:** light and dark mode, at phone and desktop widths, with no horizontal scroll.

## History

- 2026-10-01: shipped (issue #12).
