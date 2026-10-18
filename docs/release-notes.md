# Release notes

## October 18, 2026

### New

- **Ignore case.** `EQUALS`, `CONTAINS` and `REGEX_MATCH` conditions have an **Ignore case** option, so one rule matches `INFO`, `info` and `Info`. See [Ignore case](rules/README.md#ignore-case).
- **Severity number.** Log rules can match `log.severity_number`, which every SDK sets the same way, and the new `LESS_THAN` operator, for example `log.severity_number` `LESS_THAN` `13` for INFO and below. See [Conditions](rules/README.md#conditions).
- **Fleet-wide THROTTLE limits.** THROTTLE rules have a **Limit applies to** setting. **Whole fleet**, the default for new rules, splits the rate between the collectors currently reporting, so several gateway replicas together pass at most the rate. **Each collector** keeps the previous behavior. See [Set THROTTLE limits for several gateways](rules/README.md#set-throttle-limits-for-several-gateways).
- **THROTTLE burst.** Set how many seconds of the rate a bucket holds, so sources that send in large batches aren't clamped below the rate.
- The dashboard header shows how many collectors are online.

### Changed

- The dashboard rejects `GREATER_THAN` and `LESS_THAN` values that aren't numbers. Collectors previously never matched such rules.
- Upgrade collectors before creating ignore-case, `LESS_THAN` or `log.severity_number` rules. Older collectors match them case-sensitively or not at all.
- Existing THROTTLE rules apply to each collector, as before. Their badge now says **per collector** instead of **global**.
- Collectors send a `collector_id` and `interval_seconds` in their heartbeat, and the policy response includes `active_collectors`.
- Upgrade collectors before relying on fleet-wide THROTTLE rules. Older collectors enforce the full rate each.

## October 17, 2026

### New

- **Standalone mode with a rules file.** The collector can read its rules from a YAML file instead of the control plane, so a single `otelcol-chopper` filters telemetry on its own. Edits apply within seconds without a restart, `otelcol-chopper validate` checks the file, and a broken edit keeps the previous rules. See [Run without the control plane](rules/rules-file.md).
- **Whole-trace sampling.** SAMPLE rules have a new **Applies to** setting. **Whole traces**, the default for new rules, keeps or drops every span of a trace together, so sampling never leaves spans whose parent is missing. **Matching spans only** keeps the previous behavior. See [Sample whole traces](rules/README.md#sample-whole-traces).
- **Broken-trace warning.** A SAMPLE rule that applies to matching spans only shows **misses N% of spans · may break traces** when its condition misses spans. See [Find SAMPLE rules that break traces](rules/monitor-rule-activity.md#find-sample-rules-that-break-traces).
- **Production gateway components.** The `otelcol-chopper` distribution now includes the `memory_limiter` processor and the `file_storage` extension. Every sample configuration runs `memory_limiter` first, and the pilot gateways and the Helm chart's archive exporters keep their queues on disk, so queued telemetry survives a crash or restart. See [Run gateways in production](deploy/run-gateways-in-production.md).

### Changed

- Existing SAMPLE rules apply to matching spans only, as before.
- Collectors report a new `evaluated` count per rule in their heartbeat, and a new `sample_scope_not_supported` reason in `otelcol_chopper_filter_rule_status`.
- Upgrade collectors before creating whole-trace SAMPLE rules. Older collectors don't apply them.
- Helm chart: new `collector.memoryLimiter` and `collector.persistentQueue` values. Persistent queues are on by default, using an `emptyDir` volume.

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
