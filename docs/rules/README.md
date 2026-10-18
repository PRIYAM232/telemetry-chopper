# Shape telemetry with rules

A Telemetry Chopper **rule** tells your collectors what to do with matching telemetry. Each rule targets one signal (traces, logs or metrics), matches records with a condition, and applies one action. You create and manage rules on the dashboard. Collectors pick up changes within about 10 seconds, without restarts or configuration changes.

## Rule actions

| Action | What it does | Saves |
|---|---|---|
| **DROP** | Removes matching records in the collector. | Ingest, indexing and egress |
| **SAMPLE** | Keeps a fraction of traces and drops the rest. By default it samples whole traces, so every span of a trace is kept or dropped together. See [Sample whole traces](#sample-whole-traces). | Ingest, indexing and egress on the dropped share |
| **THROTTLE** | Limits matching records to a rate (events per second), optionally per attribute value such as `tenant_id`. Records over the limit are dropped. The limit applies to each collector separately. | Ingest, indexing and egress on the excess |
| **REDACT** | Masks the matched value, or only the substrings a regular expression matches, before data leaves your network. | Nothing; the record is still sent |
| **ROUTE** | Tags matching data so the collector's routing connector sends it to a different pipeline, such as cold storage. | Nothing; the record is still sent |
| **EXCLUDE_INDEX** | Forwards matching records but marks them so your vendor keeps them out of its paid search index. See [Keep events out of your vendor's index](exclude-from-index.md). | Indexing only |

Not every action applies to every signal:

| Action | Traces | Logs | Metrics |
|---|---|---|---|
| DROP | ✓ | ✓ | ✓ |
| SAMPLE | ✓ | | |
| THROTTLE | ✓ | ✓ | ✓ |
| REDACT | ✓ | ✓ | |
| ROUTE | ✓ | ✓ | ✓ |
| EXCLUDE_INDEX | ✓ | ✓ | |

A rule whose action doesn't apply to its signal is saved, but collectors don't enforce it, and the dashboard marks it **not enforced yet**. See [Monitor what each rule is doing](monitor-rule-activity.md).

### Sample whole traces

A SAMPLE rule's **Applies to** setting chooses which spans its keep-or-drop decision covers:

| Applies to | What it samples | Condition |
|---|---|---|
| **Whole traces** (default) | Every trace. All spans of a trace are kept or dropped together, so traces stay complete. | None |
| **Matching spans only** | Only the spans the condition matches. | Required |

The decision is based on the trace ID, so every collector reaches the same decision for a trace without coordinating.

With **Matching spans only**, spans the condition misses are always kept, even when the rest of their trace is sampled out. Their parents can then be missing, which breaks the trace in your backend. Spans from browsers, proxies and third-party components often lack attributes your services set, such as `service.namespace`. Use **Matching spans only** with a condition every span of the traces you sample has.

The rule card shows **misses N% of spans · may break traces** when collectors see spans that a **Matching spans only** rule's condition misses. See [Monitor what each rule is doing](monitor-rule-activity.md#find-sample-rules-that-break-traces).

SAMPLE rules created before October 17, 2026 apply to matching spans only. To switch one to whole traces, create a new SAMPLE rule with **Whole traces** and delete the old one.

### Size THROTTLE limits for your gateway count

Each collector enforces a THROTTLE rule's limit on the traffic it sees. With several gateway replicas sharing the load, the fleet-wide rate can reach the limit times the number of replicas. To cap the fleet at a rate, divide it by the number of replicas. Each collector allows a burst of one second's worth of records, so sources that send in large, infrequent batches can pass less than the limit.

## Conditions

A condition compares one field with a value: `<field> <operator> <value>`.

| Operator | Matches when the field… |
|---|---|
| `EQUALS` | equals the value exactly. Numbers compare as text, so `404` matches both `"404"` and `404`. |
| `CONTAINS` | contains the value. |
| `REGEX_MATCH` | matches the regular expression. Patterns use RE2 syntax, so lookarounds and backreferences aren't supported. The dashboard rejects patterns RE2 can't compile. |
| `GREATER_THAN` | is a number greater than the value. |
| `LESS_THAN` | is a number less than the value. |
| `EXISTS` | is present (the value is ignored). |

The dashboard rejects a `GREATER_THAN` or `LESS_THAN` value that isn't a number.

### Ignore case

`EQUALS`, `CONTAINS` and `REGEX_MATCH` are case-sensitive unless you select **Ignore case**. Telemetry often spells the same value differently depending on the SDK, so `log.severity` `EQUALS` `INFO` misses `info`. With **Ignore case**, `EQUALS` `INFO` matches `INFO`, `info` and `Info`, `CONTAINS` `timeout` matches `Upstream TIMEOUT`, and a REDACT rule with `REGEX_MATCH` masks every casing of the match. The rule card shows **ignore case** after the condition.

**Ignore case** compares whole values, so `EQUALS` `info` still doesn't match `Information`. To match every spelling of a log level, use `log.severity_number` instead.

The field is looked up on the record's attributes first, then on its resource attributes (for example `service.name`). A few special fields read the record itself:

| Field | Signal | Reads |
|---|---|---|
| `log.severity` | Logs | The severity text, such as `ERROR`. SDKs spell levels differently (`INFO`, `info`, `Information`), so select **Ignore case**, or use `log.severity_number`. |
| `log.severity_number` | Logs | The severity number, which SDKs set consistently: 1–4 TRACE, 5–8 DEBUG, 9–12 INFO, 13–16 WARN, 17–20 ERROR, 21–24 FATAL. For example, `LESS_THAN` `13` matches INFO and below, and `GREATER_THAN` `16` matches ERROR and above. Records without a severity number don't match. |
| `log.body` | Logs | The log message body |
| `metric.name` | Metrics | The metric name, such as `http.server.duration` |

Metric rules can match on `metric.name` or on resource attributes, but not on datapoint attributes.

## How rules are evaluated

- Rules run in the order they were created.
- The first rule that drops a record ends evaluation for that record. Later rules don't see it.
- Actions that don't drop (REDACT, ROUTE, EXCLUDE_INDEX, and a SAMPLE or THROTTLE that keeps the record) let evaluation continue. A later rule can still drop the record.
- A rule that can't be applied, for example one with an invalid pattern, is skipped. Collectors never block telemetry because of a bad rule.

## Create a rule

1. Open the dashboard. In **Policy rules**, find the **New rule** form.
2. Enter a **Name**, and choose an **Action** and a **Signal**.
3. Under **Condition**, enter the field, choose an operator and enter the value.
4. Fill in any fields the action needs: a sample rate and **Applies to** for SAMPLE, a rate and optional group-by attribute for THROTTLE, or a destination for ROUTE. A SAMPLE rule that applies to whole traces has no condition, so the form hides **Condition**.
5. Click **Create rule**.

The rule appears in the list and collectors start enforcing it on their next poll.

## Next steps

- [Monitor what each rule is doing](monitor-rule-activity.md)
- [Pause, delete and restore rules](pause-and-delete-rules.md)
- [Configure vendor pricing](../savings/configure-vendor-pricing.md) to see what your rules save in dollars

## Frequently asked questions

### How quickly do rule changes take effect?

Collectors poll for rule changes every 10 seconds, so a new, paused or deleted rule takes effect within about 10 seconds. No restart is needed.

### What happens if the control plane is unavailable?

Collectors keep enforcing the last ruleset they received and keep forwarding telemetry. Their counts are held and sent with the next successful heartbeat.

### Can two rules match the same record?

Yes. Every rule that matches is applied in order until one drops the record. For example, a REDACT rule can mask a field and a later ROUTE rule can send the same record to cold storage.

### Can I sample only some traces, such as one service's?

Not as whole traces. A collector decides on each span as it arrives, and a trace's spans arrive from many services at different times, so a condition met by one span can't be applied to the rest of its trace. Use **Matching spans only** with a condition every span of those traces has, or sample in your SDKs.

### What happens to a whole-trace SAMPLE rule on an older collector?

Collectors released before October 17, 2026 don't know the setting, so they don't apply the rule, and its card shows **no matches**. Upgrade your collectors before you create whole-trace SAMPLE rules.

### How do I drop debug and info logs from every service?

Create a DROP rule for **LOGS** on `log.severity_number` `LESS_THAN` `13`. It matches TRACE, DEBUG and INFO records however each SDK spells the level.

### What happens to an ignore-case or LESS_THAN rule on an older collector?

Collectors released before October 18, 2026 compare case-sensitively and don't know `LESS_THAN` or `log.severity_number`, so those rules match less, or nothing. Upgrade your collectors before you create them.

### Why does a ROUTE rule move records I didn't match?

Routing works per resource, not per record. When one record matches, every record from the same resource in that batch follows it. Emit data you want to route under its own resource, for example a separate logger with its own `service.name`. See [Routing to hot and cold backends](../../README.md#routing-to-hot-and-cold-backends).
