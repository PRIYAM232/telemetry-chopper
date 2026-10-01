# Pause, delete and restore rules

Telemetry Chopper gives you two ways to stop a rule: **pause** it, or **delete** it. Both stop enforcement on the collectors' next policy poll, within about 10 seconds. They differ in what you can get back.

| | Pause | Delete |
|---|---|---|
| Stops enforcement | ✓ | ✓ |
| Keeps the rule and its settings | ✓ | Only for the 60-second undo window |
| Keeps the rule's match and drop history | ✓ | Only for the 60-second undo window |
| Reversible | Anytime, with **Resume** | With **Undo**, shortly after deleting |

If you might need the rule again, pause it.

## Pause or resume a rule

On the rule's card, click **Pause**. The card dims and shows a **paused** badge. To turn the rule back on, click **Resume**.

A paused rule is never reported as a problem: it doesn't trigger the not-enforced alert or the **no matches** badge.

## Delete a rule

1. On the rule's card, click **Delete**. A confirmation dialog names the rule and explains what happens.
2. Choose one of the following:
   - **Cancel** closes the dialog without changes. Cancel is selected when the dialog opens, so pressing **Enter** or **Esc** never deletes the rule.
   - **Pause instead** pauses the rule and keeps it. This option appears for active rules only.
   - **Delete rule** deletes the rule.

When you delete a rule, its card disappears, collectors stop enforcing it on their next poll, and a message at the bottom of the screen confirms the delete.

## Undo a delete

The confirmation message stays on screen for 15 seconds. To restore the rule, click **Undo** in the message.

The restored rule comes back exactly as it was: same settings, same position in the list and same history. Collectors pick it up on their next poll.

If you click **Undo** more than 60 seconds after deleting, the message reads **Too late to undo**, because the rule has been permanently deleted. Create the rule again if you need it.

> **Note:** Undo is available only in the browser window where you deleted the rule.

## Frequently asked questions

### Does deleting a rule delete the data it already dropped?

Dropped data was never sent anywhere, so there is nothing to delete. Deleting a rule permanently removes the rule and its per-rule counts once the undo window closes. Fleet-wide totals, such as total telemetry dropped and savings, are unaffected.

### Why does a deleted rule stop working before I can undo?

Collectors stop enforcing a deleted rule on their next poll, so that a deleted rule never keeps dropping or redacting data. If you undo, collectors enforce the rule again on their following poll. Records that pass through in between aren't affected by the rule.

### Can I edit a rule?

Not yet. To change a rule, create a new rule with the settings you want, then delete or pause the old one.
