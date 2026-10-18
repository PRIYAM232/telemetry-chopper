# Run without the control plane: the rules file

The `otelcol-chopper` collector can read its rules from a YAML file on disk instead of from the control plane. Use a rules file when you want to filter telemetry with a single collector and nothing else: no web app, no database.

Rules from a file work exactly like rules from the dashboard. They use the same actions, conditions and evaluation order (see [Shape telemetry with rules](README.md)).

| | Rules file | Control plane |
|---|---|---|
| What you run | The collector | The collector, the control plane and PostgreSQL |
| Where you edit rules | A YAML file, in your editor or Git | The dashboard |
| How changes apply | Within seconds of saving, no restart | Within one poll interval, no restart |
| Savings dashboard, per-rule dollar figures, audit log | — | ✓ |
| Per-rule match and drop counts | Prometheus self-metrics | Dashboard and Prometheus self-metrics |

## Set up a rules file

1. In the collector configuration, set `rules_file` on the `chopper_filter` processor:

   ```yaml
   processors:
     chopper_filter:
       rules_file: /etc/telemetry-chopper/rules.yaml
       rules_file_check_interval: 5s
   ```

   Don't set `sync_endpoint` or `stats_endpoint` as well: a collector takes its rules from the file or from the control plane, not both.

2. Write your rules. Start from [`data-plane/config/rules.example.yaml`](../../data-plane/config/rules.example.yaml):

   ```yaml
   rules:
     - name: drop-health-checks
       signal: traces
       action: drop
       when: { field: http.route, op: regex_match, value: '^/(healthz|readyz)$' }
   ```

3. Check the configuration and the rules without starting the collector:

   ```bash
   otelcol-chopper validate --config /etc/telemetry-chopper/config.yaml
   ```

   A mistake is reported with the rule's position, name and the problem, for example `rule 3 ("keep-some"): sample_rate must be greater than 0 and at most 1, got 10`.

4. Start the collector. It logs `chopper_filter rules file: ruleset updated` with the number of rules enforced for each signal.

To try it from a checkout, build the collector and run the ready-made standalone configuration, which uses the example rules:

```bash
make build
data-plane/dist/otelcol-chopper --config data-plane/config/otelcol-standalone.yaml
```

## Change rules

Edit the file and save it. The collector checks the file every `rules_file_check_interval` (5 seconds by default) and applies a changed file without a restart. Each change logs `chopper_filter rules file: ruleset updated`.

If the edited file has a mistake, the collector keeps enforcing the previous rules and logs `chopper_filter rules file: not applied, keeping the current rules` with the problem. The message is logged once per problem, not on every check. When you fix the file, the collector logs `chopper_filter rules file: valid again` and applies it.

On startup the rules are stricter: a collector won't start with a rules file it can't read or that has a mistake.

## Rules file reference

The file has one top-level key, `rules`, holding a list. Rules run in the order they're listed. An empty file, or `rules: []`, is valid and lets everything through.

### Rule settings

| Setting | Required | Description |
|---|---|---|
| `name` | Yes | Unique within the file, at most 128 characters. Appears in the collector log and in the `rule_name` label of the self-metrics. |
| `signal` | Yes | `traces`, `logs` or `metrics`. |
| `action` | Yes | `drop`, `sample`, `redact`, `route`, `throttle` or `exclude_index`. See [Rule actions](README.md#rule-actions) for which actions each signal supports. |
| `when` | Yes, except for whole-trace `sample` | The condition that selects records. See [Conditions](#conditions). |
| `enabled` | No | `false` pauses the rule: it stays in the file but isn't enforced. Default `true`. |
| `sample_rate` | For `sample` | The fraction of traces to keep, greater than 0 and at most 1. `0.1` keeps 10%. |
| `sample_scope` | No, `sample` only | `trace` (default) keeps or drops whole traces and takes no `when`. `span` samples only spans matching `when`; see [Sample whole traces](README.md#sample-whole-traces) for why that can break traces. |
| `destination` | For `route` | The routing connector table entry to send matches to, such as `cold-storage`. Letters, digits and `. _ / -`. |
| `throttle_rate` | For `throttle` | Records per second allowed through, from 1 to 1,000,000. |
| `throttle_group_by` | No, `throttle` only | An attribute key, such as `tenant_id`, that gives each of its values its own limit. |
| `throttle_burst_seconds` | No, `throttle` only | How many seconds of the rate a bucket can hold, from 1 to 300, so sources that send in large batches aren't clamped below the rate. Default 1. |

A setting that belongs to another action, such as `sample_rate` on a `drop` rule, is an error rather than being ignored. So is a misspelled key.

### Conditions

```yaml
when: { field: log.severity, op: equals, value: debug, ignore_case: true }
```

| Key | Description |
|---|---|
| `field` | An attribute name, or one of the record fields `log.severity`, `log.severity_number`, `log.body` and `metric.name`. See [Conditions](README.md#conditions). |
| `op` | `equals`, `contains`, `regex_match`, `exists`, `greater_than` or `less_than`. |
| `value` | Required for every `op` except `exists`, which takes none. `greater_than` and `less_than` need a number. `regex_match` takes a Go RE2 pattern: no lookaround or backreferences. Quote patterns in single quotes so YAML leaves backslashes alone. |
| `ignore_case` | `true` makes `equals`, `contains` and `regex_match` ignore case. |

Unquoted numbers are fine: `value: 404` matches the attribute whether it's sent as the string `"404"` or the number `404`.

Action, signal, scope and operator names are case-insensitive, so `action: DROP` works too.

## Monitor a collector that uses a rules file

There's no dashboard in standalone mode, so watch the collector's self-metrics (see [Monitor collectors with Prometheus and Grafana](../monitoring/README.md)):

- `otelcol_chopper_filter_spans_received`, `otelcol_chopper_filter_spans_dropped` and the logs and metrics equivalents show overall volume and drops.
- `otelcol_chopper_filter_rule_matched` and `otelcol_chopper_filter_rule_dropped` count each rule's matches and drops, labelled with the `rule_name` from your file.
- `otelcol_chopper_filter_rule_status` shows every rule as enforced or paused. A rules file can't contain invalid rules, so the **Rules not enforced** alert stays quiet unless you disable rules.

Each rule's `rule_id` label is `<signal>/<action>/<name>`, for example `traces/drop/drop-health-checks`. Changing a rule's signal or action therefore starts its counters from zero, as a new rule.

## Frequently asked questions

### Can I use a rules file and the control plane together?

Not on the same `chopper_filter` processor. To manage some collectors from the dashboard and run others standalone, give each collector the configuration it needs.

### Does a rules file work with a Kubernetes ConfigMap?

Yes. Mount the ConfigMap as a volume and point `rules_file` at the mounted file. Kubernetes updates mounted ConfigMaps in place, usually within a minute of `kubectl apply`, and the collector picks the change up on its next check. Don't mount it with `subPath`: Kubernetes never updates files mounted that way.

### Is a THROTTLE rate per collector or for the whole fleet?

Per collector. A collector with a rules file has no control plane to count its peers, so it enforces the full `throttle_rate` on its own. If you run several collectors with the same rules file behind a load balancer, divide the rate by the number of collectors yourself.

### How do I stop the collector from re-reading the file?

Set `rules_file_check_interval: 0`. The file is then read once at startup, and changes need a restart.

### What happens to a ROUTE rule if the collector has no routing connector?

The rule still stamps `chopper.routing.destination` on the records it matches, but nothing reads the stamp, so the records go wherever the pipeline sends everything else. Add a `routing` connector with a table entry for each destination; [`otelcol-dev.yaml`](../../data-plane/config/otelcol-dev.yaml) shows one.
