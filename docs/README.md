# Telemetry Chopper documentation

Telemetry Chopper is an open-source control plane for OpenTelemetry. It lets you drop, sample, redact, route and rate-limit traces, logs and metrics at the edge, before they reach your observability vendor, and it shows what those policies save you in dollars.

A Telemetry Chopper deployment has two parts:

- The **data plane** is `otelcol-chopper`, an OpenTelemetry Collector distribution that applies your policy rules to telemetry as it passes through.
- The **control plane** is a web application where you write rules, configure your vendor's pricing and watch savings in real time. Collectors pick up rule changes within seconds, without restarts.

New to Telemetry Chopper? Start with the [quick start](../README.md#quick-start--5-minutes-to-value) to run the full stack locally in about five minutes, then read [Key concepts](concepts.md).

## Shape telemetry with rules

Rules decide what happens to each span, log record and metric that reaches a collector.

- [Rules overview](rules/README.md): the six rule actions and how rules are evaluated.
- [Keep events out of your vendor's index](rules/exclude-from-index.md): forward data for live tail and archives without paying to make it searchable.
- [Monitor what each rule is doing](rules/monitor-rule-activity.md): per-rule match and drop counts, savings, and warnings for rules that never match or can't run.
- [Pause, delete and restore rules](rules/pause-and-delete-rules.md): turn a rule off safely and undo an accidental delete.

## Measure observability savings

Telemetry Chopper measures the bytes and events your rules keep away from your vendor and prices them with your contract's rates.

- [Savings overview](savings/README.md): what the dashboard shows and how to choose a time range.
- [Configure vendor pricing](savings/configure-vendor-pricing.md): enter your negotiated ingest and indexing prices.
- [Track a committed volume and overage penalties](savings/track-committed-volume.md): see where you stand against your monthly commitment and what overage your rules prevented.
- [Include cloud egress savings](savings/include-cloud-egress.md): add your cloud provider's data transfer fees to the total.
- [How savings are calculated](savings/calculations.md): the formulas behind every figure.

## Monitor Telemetry Chopper

- [Monitor collectors with Prometheus and Grafana](monitoring/README.md): self-metrics, alerts, the Grafana dashboard and the collector's sync log.

## Reference

- [Key concepts](concepts.md): the terms used throughout these docs.
- [Stats reporting API](reference/stats-api.md): the heartbeat collectors send to the control plane.
- [Release notes](release-notes.md): what changed in each release.
