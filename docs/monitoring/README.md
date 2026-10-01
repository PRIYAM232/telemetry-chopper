# Monitor collectors with Prometheus and Grafana

Each Telemetry Chopper collector reports on itself. It exposes Prometheus metrics, and it writes a log line every time it receives new rules. Use them to watch throughput and drop rates in the tools you already use, and to alert when a rule isn't doing what you expect. They work even when the control plane is unreachable.

## Collector metrics

Collectors serve metrics in Prometheus format at `:8888/metrics`. The Helm chart exposes this port as `metrics` on each collector pod and on the `chopper-collector` Service. Alongside the standard OpenTelemetry Collector metrics (`otelcol_process_*`, `otelcol_receiver_*` and others), Telemetry Chopper adds:

| Metric | Type | Description |
|---|---|---|
| `otelcol_chopper_filter_spans_received` | Counter | Spans received |
| `otelcol_chopper_filter_spans_dropped` | Counter | Spans removed by rules |
| `otelcol_chopper_filter_logs_received` | Counter | Log records received |
| `otelcol_chopper_filter_logs_dropped` | Counter | Log records removed by rules |
| `otelcol_chopper_filter_metrics_received` | Counter | Metrics received |
| `otelcol_chopper_filter_metrics_dropped` | Counter | Metrics removed by rules |
| `otelcol_chopper_filter_rules` | Gauge | Rules in the collector's current ruleset. `0` until the first successful sync. |
| `otelcol_chopper_filter_rule_matched` | Counter | Records each rule matched |
| `otelcol_chopper_filter_rule_dropped` | Counter | Records each rule removed |
| `otelcol_chopper_filter_rule_status` | Gauge | `1` for each rule, labelled with its enforcement state |

Counters are cumulative since the collector started, so use them with `rate()` or `increase()`. Metric names have no `_total` suffix.

### Per-rule labels

The `rule_matched`, `rule_dropped` and `rule_status` metrics have one series per rule, labelled:

| Label | Description |
|---|---|
| `rule_id` | The rule's ID |
| `rule_name` | The rule's name |
| `signal` | `TRACES`, `LOGS` or `METRICS` |
| `action` | The rule's action, for example `DROP` |
| `state` | `rule_status` only: `enforced`, `paused`, `invalid` or `unsupported` |
| `reason` | `rule_status` only: why the rule isn't enforced. Empty for enforced and paused rules. |

The number of series grows with the number of rules, not with traffic.

### Enforcement states and reasons

| State | Reason | Meaning |
|---|---|---|
| `enforced` | | The collector applies the rule. |
| `paused` | | The rule is paused on the dashboard. |
| `invalid` | `regex_does_not_compile` | The `REGEX_MATCH` pattern isn't valid RE2. |
| `invalid` | `missing_sample_rate` | A SAMPLE rule has no sample rate. |
| `invalid` | `missing_destination` | A ROUTE rule has no destination. |
| `invalid` | `missing_throttle_rate` | A THROTTLE rule has no positive rate. |
| `unsupported` | `action_not_supported_for_signal` | The action doesn't apply to the rule's signal, for example SAMPLE on LOGS. |
| `unsupported` | `unknown_signal` | The rule targets a signal this collector version doesn't know. |

## Collect the metrics

If you deploy with the Helm chart and run the Prometheus Operator, turn on the ServiceMonitor and the Grafana dashboard:

```sh
helm upgrade chopper deploy/helm/telemetry-chopper -n chopper --reuse-values \
  --set metrics.serviceMonitor.enabled=true \
  --set 'metrics.serviceMonitor.additionalLabels.release=kube-prometheus-stack' \
  --set metrics.dashboard.enabled=true
```

- `metrics.serviceMonitor.enabled` creates a ServiceMonitor that scrapes every collector pod. Set `additionalLabels` to match your Prometheus instance's `serviceMonitorSelector`.
- `metrics.dashboard.enabled` creates a ConfigMap labelled `grafana_dashboard: "1"`, which Grafana's dashboard sidecar imports automatically.

For other setups, configure Prometheus to scrape port `8888` on each collector. See the [Helm chart README](../../deploy/helm/README.md#self-monitoring-phase-10) for details.

## Grafana dashboard

The bundled **Telemetry Chopper — Collector Self-Monitoring** dashboard includes:

| Panel | Shows |
|---|---|
| CPU usage, Memory RSS | Collector resource use |
| Active rules synced | Rules in the current ruleset. `0` with traffic flowing usually means the collector can't reach the control plane. |
| Drop ratio (all signals) | Percentage of telemetry removed by rules |
| Received /s, Dropped by rules /s | Throughput and drops per signal |
| OTLP receiver refusals /s | Telemetry refused before reaching Telemetry Chopper, for example under backpressure |
| Dropped by rule /s (top 10) | The rules removing the most telemetry |
| Rules matching nothing (1h) | Enforced rules that matched no records in the last hour |
| Rules not enforced | The number of active rules collectors can't enforce, and a table listing each one with its reason |

## Alert when a rule isn't enforced

Paused rules are excluded, so this alert fires only for rules that should be running but aren't:

```yaml
- alert: ChopperRuleNotEnforced
  expr: max by (rule_id, rule_name, state, reason) (otelcol_chopper_filter_rule_status{state=~"invalid|unsupported"}) > 0
  for: 5m
  annotations:
    summary: 'Rule {{ $labels.rule_name }} is {{ $labels.state }}: {{ $labels.reason }}'
```

## Alert when a rule never matches

This alert catches enforced rules whose condition matched nothing for an hour, often caused by a misspelled field name:

```yaml
- alert: ChopperRuleNoMatches
  expr: |
    (sum by (rule_id, rule_name) (increase(otelcol_chopper_filter_rule_matched[1h])) == 0)
    and on (rule_id) max by (rule_id) (otelcol_chopper_filter_rule_status{state="enforced"})
  for: 15m
```

A rule for a service that has stopped sending also fires this alert.

## Collector sync log

Each time a collector receives a changed ruleset, it logs a summary at `info` level:

```text
chopper_filter policy sync: ruleset updated  {"fleet_id": "…", "rules_total": 8, "rules_enforced_traces": 3, "rules_enforced_logs": 1, "rules_enforced_metrics": 1, "rules_paused": 1, "rules_invalid": 1, "rules_unsupported": 1}
```

| Field | Description |
|---|---|
| `rules_total` | All rules received, in any state |
| `rules_enforced_traces`, `rules_enforced_logs`, `rules_enforced_metrics` | Enforced rules for each signal |
| `rules_paused` | Paused rules |
| `rules_invalid` | Rules that are malformed |
| `rules_unsupported` | Rules whose action doesn't apply to their signal |

For each invalid or unsupported rule, the collector also logs a warning that names the rule:

```text
chopper_filter policy sync: rule not enforced  {"rule": "mask-cards-lookahead", "rule_id": "…", "signal": "LOGS", "action": "DROP", "state": "invalid", "reason": "regex_does_not_compile"}
```

Paused rules don't produce a warning.

## Frequently asked questions

### Why does Prometheus show a different drop count from the dashboard?

Prometheus counters are cumulative per collector since it started, and reset when it restarts. The dashboard sums the heartbeats every collector has sent over the selected time range. Compare `increase()` over the same range for a like-for-like figure.

### Do these metrics depend on the control plane?

No. Collectors expose their metrics directly, so you can monitor them even when the control plane is down.

### What replaced the `rules_ignored` log field?

`rules_ignored` counted paused rules together with broken ones. It's replaced by `rules_paused`, `rules_invalid` and `rules_unsupported`. To alert on broken rules, use the `otelcol_chopper_filter_rule_status` metric.
