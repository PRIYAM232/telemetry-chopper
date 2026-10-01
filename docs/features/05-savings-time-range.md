# Feature 5: Savings time range

**Status:** Shipped, 2026-09-30 · **PR:** _pending_ · **Issue:** [#15](https://github.com/PRIYAM232/telemetry-chopper/issues/15)

## Summary

The dashboard's savings cards used to sum every heartbeat since the fleet was created. After you added or changed rules, the unfiltered traffic from before the change kept dominating the totals, so **Data reduction** crept up for hours: 13% → 46% → 81% in one sandbox session, with a true steady state of ~88%.

The banner and the **Savings breakdown** widget now cover a selectable window: **1h**, **24h** (the default), **7d** or **All time**. The number you show your manager reflects what the current ruleset is doing.

The other half of issue #15, the hardcoded $0.15 per million, was already fixed by [Feature 1](01-vendor-rate-cards.md): savings are priced on measured bytes at your rate card, and the card names the rate it used.

## Using it

- Pick a window with the **1h · 24h · 7d · All time** control above the cards. The header reads *Savings over the last hour* (or the window you chose), and every card hint and the breakdown header name the same window.
- The choice lives in the URL (`/dashboard?range=1h`), so you can bookmark or share it. Auto-refresh keeps it, and the page works without JavaScript.
- If the window has no heartbeats, the header says *no heartbeats in this window* and **Data reduction** shows `—` instead of a misleading `0.0%`.
- **This billing period** keeps its own window (your billing cycle), whatever range you pick.

## How it's calculated

Each card sums the `FleetMetric` heartbeat rows with `createdAt ≥ now − window` (no lower bound for All time). The formulas are unchanged from Features 1–4, applied to that window's sums. The *drops unpriced* note also counts only the window, so it disappears once old pre-byte-accounting heartbeats age out. The existing `(fleetId, createdAt)` index serves these queries.

An unknown `?range=` value falls back to 24h.

## What changed

| File | Change |
|---|---|
| `src/lib/time-range.ts` | Range values, default, parser, window start, labels |
| `src/app/dashboard/range-picker.tsx` | Segmented link control (server component) |
| `src/app/dashboard/page.tsx` | Reads `searchParams.range`; banner and unpriced-drop sums filtered by window; window labels; `—` for an empty window |
| `src/app/dashboard/savings-breakdown.tsx` | Header shows the window instead of "all time" |

No schema, API or data-plane changes.

## Verification

Seeded backdated heartbeats in a scratch Postgres (10 days old with unpriced drops, 3 days old with no drops, 5 h old at 50%, 30 min old at 88%), then clicked each tab in the browser. Every card matched the hand-computed values:

| Window | Received | Dropped | Reduction | Savings (default $0.10/GB) | Unpriced note |
|---|---|---|---|---|---|
| 1h | 3,000 | 2,640 | 88.0% | $0.03 | none |
| 24h | 8,000 | 5,140 | 64.3% | $0.13 | none |
| 7d | 18,000 | 5,140 | 28.6% | $0.13 | none |
| All time | 28,000 | 6,140 | 21.9% | $0.13 | 1,000 drops |

Also checked: `?range=bogus` → 24h; an empty 1h window shows the empty-state header and `—`; a heartbeat inserted while viewing 1h appeared within one 10 s refresh with no reload and the URL kept `?range=1h`; light and dark mode, phone and desktop widths.

## History

- 2026-09-30: shipped (issue #15).
