# Monitor what each rule is doing

Each rule card on the dashboard shows how much telemetry that rule matched and removed, and what it saved. Use these counts to find the rules doing the most work, confirm that a new rule matches what you expect, and catch rules that silently do nothing.

## Read a rule's counts

Below each rule's condition, a counts line covers the time range selected above the savings cards (**1h**, **24h**, **7d** or **All time**):

| Action | The counts line shows |
|---|---|
| DROP | Records matched and dropped, the bytes dropped, the rule's share of all drops in the fleet, and what it saved |
| SAMPLE | As DROP, plus the percentage of matches **sampled out** |
| THROTTLE | As DROP, plus the percentage of matches **over the limit** |
| EXCLUDE_INDEX | Records matched, records **kept out of the index**, and what it saved |
| REDACT, ROUTE | Records matched |

The **saves** figure uses the same rate card, indexing prices and egress settings as the headline savings card, so the figures on all rule cards add up to the headline.

For THROTTLE rules, the over-the-limit percentage tells you whether the limit is actually being hit. At 0%, matching traffic is under the limit. If matches drop to zero too, the source has gone quiet.

### How matches are counted

- A record counts as **matched** by every rule whose condition it meets, up to and including the rule that drops it.
- A record is credited as **dropped** to the rule that removed it. If two DROP rules match the same record, the first one gets the credit.
- A record is credited as **kept out of the index** to the first EXCLUDE_INDEX rule that marked it, as long as no later rule dropped it.

## Find rules that never match

An amber **no matches in the last 24 hours** badge (or **no matches yet** under **All time**) flags a rule that matched nothing in the selected time range, even though its signal had traffic. The most common cause is a condition field that doesn't match how your telemetry spells it, for example `http.status_cod` instead of `http.status_code`.

The badge appears only for active, enforced rules that are more than a minute old, so a rule you just created isn't flagged before collectors have reported on it.

To fix a silent rule, check the field name and value against a real record in your vendor or in the collector's debug output.

## Find rules that aren't enforced

Collectors skip rules they can't apply rather than block telemetry. The rule card shows why:

| Badge | Meaning | What to do |
|---|---|---|
| **paused** | You paused the rule. | Click **Resume** to enforce it again. |
| **not enforced yet** | The action doesn't apply to the rule's signal, for example SAMPLE on LOGS. | Recreate the rule with a supported action or signal. See [Rule actions](README.md#rule-actions). |
| **invalid regex · not enforced** | The pattern isn't valid RE2, for example it uses a lookahead. | Recreate the rule with an RE2-compatible pattern. |

To alert on rules that aren't enforced across your collectors, use the `otelcol_chopper_filter_rule_status` metric. See [Monitor collectors with Prometheus and Grafana](../monitoring/README.md#alert-when-a-rule-isnt-enforced).

## Considerations

- Per-rule counts require collectors that report them. If your collectors are older, the **Policy rules** heading says that per-rule counts appear once your collectors report them, and the rule cards show no counts until you upgrade.
- Counts start when collectors are upgraded; earlier traffic isn't attributed to rules.
- The **no matches** badge compares a rule with all traffic for its signal across the fleet. A rule scoped to one service is also flagged when that service stops sending.

## Frequently asked questions

### Why don't a rule's matched and dropped counts agree?

They agree for DROP rules. SAMPLE and THROTTLE drop only part of what they match. REDACT, ROUTE and EXCLUDE_INDEX never drop. A record dropped by an earlier rule never reaches later rules, so it isn't counted as a match for them.

### Why is a rule's share of fleet drops less than 100% when it's my only DROP rule?

SAMPLE and THROTTLE rules also drop records, and their drops count toward the fleet total.

### Can I see per-rule counts in Prometheus?

Yes. Collectors export `otelcol_chopper_filter_rule_matched` and `otelcol_chopper_filter_rule_dropped`, labelled with the rule's ID and name. See [Monitor collectors with Prometheus and Grafana](../monitoring/README.md).
