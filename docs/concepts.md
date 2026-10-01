# Key concepts

This page defines the terms used throughout the Telemetry Chopper documentation.

## Fleet

A **fleet** is a group of collectors that share one set of rules and report to the same dashboard. Each fleet has an ID and an API key, which its collectors use to authenticate. Rate cards, commitments and egress settings are configured per fleet.

## Collector

A **collector** is one running instance of `otelcol-chopper`, the Telemetry Chopper distribution of the OpenTelemetry Collector. Your applications send OTLP telemetry to it, and its `chopper_filter` processor applies your rules before passing data on to your observability vendor.

If a collector can't reach the control plane, it keeps applying the last ruleset it received. Telemetry is never blocked because the control plane is down.

## Signal

A **signal** is one of the three OpenTelemetry data types: **traces** (spans), **logs** (log records) and **metrics**. Every rule targets exactly one signal.

## Rule

A **rule** is a condition plus an action, for example *LOGS where `log.severity` EQUALS `DEBUG` → DROP*. Collectors poll the control plane for rule changes every 10 seconds and apply them without restarting. See [Rules overview](rules/README.md).

## Heartbeat

Every 10 seconds each collector sends a **heartbeat** to the control plane: how many records it received and dropped since the last heartbeat, how many bytes those records were, and how much of that each rule accounts for. The dashboard's figures are sums of heartbeats. If a heartbeat fails, the collector adds its counts to the next one, so nothing is lost.

## Dropped and forwarded bytes

- **Dropped bytes** are the size of the records your rules removed. Your vendor never receives or bills them.
- **Forwarded bytes** are the size of what the collector passed downstream. This is the volume your vendor still bills.

Both are measured as OTLP protobuf sizes, in decimal gigabytes (1 GB = 10⁹ bytes), the unit vendors bill in.

## Ingest and indexing

Many vendors charge twice for the same data:

- **Ingest** is billed per GB received.
- **Indexing** is billed per million events made searchable.

A dropped record saves both. A record you forward but keep out of the index saves indexing only. See [Keep events out of your vendor's index](rules/exclude-from-index.md).

## Rate card

A **rate card** holds your negotiated prices: ingest per GB for each signal, and indexing per million events for spans and logs. The dashboard uses it to turn bytes and events into dollars. See [Configure vendor pricing](savings/configure-vendor-pricing.md).

## Committed volume and overage

Many contracts include a **committed volume**, a number of GB per month billed at your standard rate. Every GB past it is **overage**, billed at a multiple of the standard rate (for example 1.5×). See [Track a committed volume and overage penalties](savings/track-committed-volume.md).

## Cloud egress

**Egress** is the fee your cloud provider charges for data leaving its network, for example to reach a SaaS vendor over the internet. Data dropped in the collector never leaves, so it saves egress too. See [Include cloud egress savings](savings/include-cloud-egress.md).

## Enforcement status

Every rule a collector receives is in one of four states:

| State | Meaning |
|---|---|
| **Enforced** | The collector applies the rule. |
| **Paused** | You turned the rule off. |
| **Invalid** | The rule is malformed (for example, a regular expression that doesn't compile), so the collector skips it. |
| **Unsupported** | The rule is valid, but the action doesn't apply to its signal (for example, SAMPLE on LOGS). |

See [Monitor what each rule is doing](rules/monitor-rule-activity.md).
