# Release notes

## October 2, 2026

### New

- **Pilot rehearsal environment.** Run Telemetry Chopper as a two-replica gateway tier behind an agent collector, in front of the OpenTelemetry Demo, shipping to Tempo, Loki and Prometheus with Grafana dashboards. Includes a test plan and reference results. See [Pilot rehearsal environment](../deploy/pilot/README.md).

### Documentation

- [Rules overview](rules/README.md#sample-whole-traces): how to sample whole traces, how THROTTLE limits behave with several gateway replicas, and matching severity text case-insensitively.

## October 1, 2026

### New

- **Per-rule activity.** Each rule card shows the records the rule matched and dropped, its share of all drops, and what it saved, for the selected time range. Collectors also export per-rule Prometheus metrics. See [Monitor what each rule is doing](rules/monitor-rule-activity.md).
- **No-matches warning.** Rules that match nothing while their signal has traffic are flagged, which catches misspelled condition fields.
- **Rule enforcement status.** Collectors report each rule as enforced, paused, invalid or unsupported, with a reason, in the new `otelcol_chopper_filter_rule_status` metric and in their sync log. The Grafana dashboard adds **Rules not enforced** panels. See [Monitor collectors with Prometheus and Grafana](monitoring/README.md).
- **Safer deletes.** Deleting a rule now asks for confirmation, offers **Pause instead**, and can be undone. See [Pause, delete and restore rules](rules/pause-and-delete-rules.md).

### Changed

- The collector sync log replaces `rules_ignored` with `rules_paused`, `rules_invalid` and `rules_unsupported`. Update any log-based alerts that use `rules_ignored`.
- The **Rules matching nothing** Grafana panel counts enforced rules only. Paused rules are no longer included.

## September 30, 2026

### New

- **Vendor pricing.** Savings are priced from the measured size of dropped data and your negotiated price per GB, for Datadog, Splunk, New Relic or a custom vendor. See [Configure vendor pricing](savings/configure-vendor-pricing.md).
- **Committed volume tracking.** Track billable volume against your monthly commitment, get warned before you cross it, and see the overage penalties your rules prevented. See [Track a committed volume and overage penalties](savings/track-committed-volume.md).
- **Indexing prices and the EXCLUDE_INDEX action.** Add per-million indexing prices to your rate card, and keep forwarded events out of your vendor's index. A new **Savings breakdown** shows ingest and indexing savings separately. See [Keep events out of your vendor's index](rules/exclude-from-index.md).
- **Cloud egress savings.** Add your cloud provider's outbound transfer fee to see **Total infrastructure & ingest savings**. See [Include cloud egress savings](savings/include-cloud-egress.md).
- **Savings time range.** Choose **1h**, **24h**, **7d** or **All time** for the savings cards. The default is the last 24 hours. See [Measure observability savings](savings/README.md#choose-a-time-range).

### Changed

- Savings are no longer estimated at a fixed price per million records. Until you save a rate card, they're priced at $0.10 per GB.
- Savings under one cent are shown to two significant digits, for example $0.000022, instead of $0.0000.
