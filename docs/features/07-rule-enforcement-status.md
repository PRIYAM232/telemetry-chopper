# Feature 7: Rule enforcement status

**Status:** Shipped, 2026-10-01 · **PR:** [#41](https://github.com/PRIYAM232/telemetry-chopper/pull/41) · **Issue:** [#13](https://github.com/PRIYAM232/telemetry-chopper/issues/13)

## Summary

The collector's `rules_ignored` count lumped together rules you **paused** on purpose and rules the collector **couldn't run** (a bad regex, SAMPLE on LOGS). Pausing a rule moved the same number as breaking one, and nothing said which rules were affected. You couldn't write the alert you actually want: *a rule exists that isn't being enforced*.

Every synced rule now has exactly one state, with a reason when it isn't enforced:

| State | Meaning | Reasons |
|---|---|---|
| `enforced` | The collector evaluates it | none |
| `paused` | Turned off in the dashboard: intentional, never an alert | none |
| `invalid` | Malformed, so it fails open: a defect to fix | `regex_does_not_compile`, `missing_sample_rate`, `missing_destination`, `missing_throttle_rate` |
| `unsupported` | Well-formed, but this collector doesn't implement the action on that signal, or doesn't know the action or signal | `action_not_supported_for_signal`, `unknown_signal` |

## Using it

**Collector log.** The `ruleset updated` line replaces `rules_ignored` with three counts:

```text
"rules_total": 8, "rules_enforced_traces": 3, "rules_enforced_logs": 1, "rules_enforced_metrics": 1, "rules_paused": 1, "rules_invalid": 1, "rules_unsupported": 1
```

Each invalid or unsupported rule also gets its own warning, which names it and gives the reason:

```text
chopper_filter policy sync: rule not enforced  {"rule": "mask-cards-lookahead", "rule_id": "…", "signal": "LOGS", "action": "DROP", "state": "invalid", "reason": "regex_does_not_compile"}
```

Paused rules produce no warning.

**Prometheus.** `otelcol_chopper_filter_rule_status` reports 1 per synced rule, labelled `rule_id`, `rule_name`, `signal`, `action`, `state` and `reason`. To alert:

```yaml
- alert: ChopperRuleNotEnforced
  expr: max by (rule_id, rule_name, state, reason) (otelcol_chopper_filter_rule_status{state=~"invalid|unsupported"}) > 0
  for: 5m
```

**Grafana** (Helm chart dashboard):
- a **Rules not enforced** stat (red when above 0);
- a **Rules not enforced** table listing each rule with its signal, action, state and reason.

**Rules matching nothing (1h)** (from Feature 6) now counts enforced rules only. Before, it also counted paused rules, the same conflation this issue is about, and rules deleted within the hour.

## How it works

`ruleStatus` (`status.go`) classifies each rule once, when the ruleset is compiled at sync time, and stores the result on the compiled rule. The log line, the per-rule warnings and the gauge all read that one value, so they can't disagree. "Enforced" is defined as "one of the hot path's `ruleApplies*` gates accepts the rule". A test checks every combination of signal, action, parameters, regex and active flag (2,016 cases), so the status can't drift from what the collector actually does.

The gauge is an asynchronous gauge that reads the current ruleset when Prometheus scrapes, so it adds nothing to the hot path.

## What changed

| File | Change |
|---|---|
| `data-plane/processors/filterprocessor/status.go` (new) | States, reasons, `ruleStatus` |
| `rules.go` | `compiledRule.state` / `stateReason` set by `compileRules`; the THROTTLE no-rate warning moved into the per-rule sync warning |
| `engine.go` | `rules_paused` / `rules_invalid` / `rules_unsupported` replace `rules_ignored`; one `rule not enforced` warning per broken rule |
| `telemetry.go`, `factory.go` | `otelcol_chopper_filter_rule_status` gauge |
| `deploy/helm/telemetry-chopper/files/chopper-collector-dashboard.json` | Two **Rules not enforced** panels; **Rules matching nothing** limited to enforced rules |
| `deploy/helm/README.md`, `deploy/sandbox/README.md` | Metric table, alert example, new log fields |

## Upgrading and compatibility

`rules_ignored` is gone from the log line. A log-based alert on it should switch to `rules_invalid + rules_unsupported`, or better, to the `rule_status` metric. The dashboard's own "not enforced yet" and "invalid regex" badges are unchanged.

## Verification

- **Unit tests:**
  - one case per state and reason, including "a paused rule with a bad regex is paused, not invalid";
  - the exhaustive check above (2,016 combinations), which confirms "enforced" agrees with the hot path's gates;
  - a sync test that checks the real log fields and that only broken rules warn, never paused ones.
  - The suite passes under the race detector.
- **Full stack** (a collector built from the branch, plus a Prometheus server scraping it), replaying the issue's sandbox session:

  | Step | Log line | Prometheus |
  |---|---|---|
  | 8 rules, one bad regex, one SAMPLE on LOGS | enforced 3/2/1, paused 0, invalid 1, unsupported 1; both named in warnings | `rule_status` enforced 6, invalid 1, unsupported 1; alert firing for both rules |
  | Paused `throttle-noisy-tenants` | logs 2 → 1, **paused 1**, invalid/unsupported unchanged; no warning | paused 1; not-enforced count still 2; alert unchanged |
  | Resumed it | paused 0 | none |
  | Fixed the regex, deleted SAMPLE on LOGS | invalid 0, unsupported 0 | all 7 enforced; table empty; alert cleared |

  The corrected **Rules matching nothing** query: 7 with no traffic, then 6 after pausing a rule. The old query read 8 in both cases.
- All new PromQL, including the alert, passes `promtool check rules` and was evaluated live by the Prometheus server.

## History

- 2026-10-01: shipped (issue #13).
