# Release notes

## October 20, 2026

### New

- **Traces from Datadog tracing libraries.** `otelcol-chopper` now includes a Datadog receiver. Services instrumented with Datadog's tracing libraries can send traces to the collector on port 8126, and your rules apply to them like OpenTelemetry spans. A transform step keeps their operation and resource names in Datadog APM. In the Helm chart, set `collector.datadogReceiver.enabled`. See [Filter traces from Datadog tracing libraries](deploy/datadog-tracing-libraries.md).
- **Helm hot backend.** `collector.hotBackend.otlp.endpoint` sends what your rules keep to an OTLP gRPC endpoint, such as a Datadog Agent, instead of the `debug` exporter.
- The Datadog test harness sends traces with Datadog's Python tracing library: `run.sh send-ddtrace`.
- **Fleets page.** Create a fleet for each group of collectors that should run different rules, such as each environment or region, from the new **Fleets** page. Each fleet gets its own key, shown once when it's created. See [Create fleets and rotate fleet keys](deploy/manage-fleets.md).
- **Fleet key rotation.** Replace a fleet's key from the **Fleets** page. Choose whether the old key stops working immediately or after 1 hour, 24 hours or 7 days, and see how many online collectors still use it. **Revoke now** ends the grace period early. See [Rotate a fleet key](deploy/manage-fleets.md#rotate-a-fleet-key).
- **Fleet picker.** With more than one fleet, pick which one the **Dashboard** and **Pricing** pages show from the menu next to the fleet name.
- The audit log records fleets created, keys rotated and previous keys revoked.
- **Span allowances.** Enter the span volume your plan includes each month, such as Datadog's 150 GB of ingested spans and 1 million indexed spans per APM host, on the **Pricing** page. Span savings then only count usage above the allowance, worked out per billing month. See [Span allowances](savings/configure-vendor-pricing.md#span-allowances).
- **Metric series pricing.** For vendors that bill custom metrics by series, such as Datadog, set a **Metric series price** per 100 series per month on the **Pricing** page. Collectors now count the distinct metric series their rules drop each hour, and the dashboard prices them as series-hours instead of bytes. See [Configure vendor pricing](savings/configure-vendor-pricing.md).
- **Datadog test harness.** Run Telemetry Chopper in front of your Datadog account: the collector sends OTLP to a Datadog Agent, a script sends labelled logs, traces and metrics, and a table lists what Datadog should show for each DROP, REDACT, EXCLUDE_INDEX and ROUTE rule. See [Datadog test harness](../deploy/datadog/README.md).

### Changed

- The control plane stores fleet keys as SHA-256 hashes instead of the keys themselves, so it can't show a key again after the first time. Upgrading converts existing keys; collectors need no changes.
- The seed step in the Docker Compose, sandbox and pilot stacks and the Helm chart only creates `local-dev-fleet` when it doesn't exist. It used to write the fleet's published key and sample rules back on every start or upgrade, undoing a rotated key, a paused rule or an edited one.
- With no fleet, the dashboard and pricing pages link to the **Fleets** page instead of asking you to run the seed.
- The Helm chart keeps the fleet key in a `<release>-fleet` Secret instead of the collector ConfigMap, and restarts the collectors when `fleet.key` changes. The new `fleet.existingSecret` value uses a Secret you manage instead. Upgrades need no value changes. See [Create a fleet](deploy/manage-fleets.md#create-a-fleet).
- Upgrade collectors to get metric series savings. Older collectors don't report dropped series, so their series savings stay at $0. Existing rate cards get a series price of $0, so their savings don't change.
- Pricing examples in the docs and on the **Pricing** page use Datadog's current monthly-plan list price for indexing, $2.04 per million events, instead of $1.70.

## October 18, 2026

### New

- **Operator sign-in.** The dashboard, pricing settings and every change now require signing in. Each person has their own operator account; add and remove them on the new **Operators** page. The first operator comes from `CHOPPER_ADMIN_EMAIL` and `CHOPPER_ADMIN_PASSWORD` and must choose a new password at first sign-in. See [Sign in, manage operators and review the audit log](deploy/sign-in-and-operators.md).
- **Audit log.** A new **Audit log** page records every rule, pricing and operator change, and every sign-in, with who did it and when.
- **Ignore case.** `EQUALS`, `CONTAINS` and `REGEX_MATCH` conditions have an **Ignore case** option, so one rule matches `INFO`, `info` and `Info`. See [Ignore case](rules/README.md#ignore-case).
- **Severity number.** Log rules can match `log.severity_number`, which every SDK sets the same way, and the new `LESS_THAN` operator, for example `log.severity_number` `LESS_THAN` `13` for INFO and below. See [Conditions](rules/README.md#conditions).
- **Fleet-wide THROTTLE limits.** THROTTLE rules have a **Limit applies to** setting. **Whole fleet**, the default for new rules, splits the rate between the collectors currently reporting, so several gateway replicas together pass at most the rate. **Each collector** keeps the previous behavior. See [Set THROTTLE limits for several gateways](rules/README.md#set-throttle-limits-for-several-gateways).
- **THROTTLE burst.** Set how many seconds of the rate a bucket holds, so sources that send in large batches aren't clamped below the rate.
- The dashboard header shows how many collectors are online.

### Changed

- Upgrading: sign in with `CHOPPER_ADMIN_EMAIL` / `CHOPPER_ADMIN_PASSWORD` after this release. The Docker Compose, sandbox and pilot stacks default to `admin@localhost` / `chopper-admin-dev`; the Helm chart generates a password into the `<release>-admin` Secret (new `controlPlane.admin` values). Collectors need no changes.
- `/` now redirects to the dashboard (or the sign-in page) instead of showing the framework's starter page.
- The dashboard rejects `GREATER_THAN` and `LESS_THAN` values that aren't numbers. Collectors previously never matched such rules.
- Upgrade collectors before creating ignore-case, `LESS_THAN` or `log.severity_number` rules. Older collectors match them case-sensitively or not at all.
- Existing THROTTLE rules apply to each collector, as before. Their badge now says **per collector** instead of **global**.
- Collectors send a `collector_id` and `interval_seconds` in their heartbeat, and the policy response includes `active_collectors`.
- Upgrade collectors before relying on fleet-wide THROTTLE rules. Older collectors enforce the full rate each.

### Documentation

- The README's security section no longer says collectors keep no telemetry on disk. Since persistent exporter queues arrived on October 17, queued batches wait on the gateway's disk until they're sent. [Which telemetry does a gateway write to disk?](deploy/run-gateways-in-production.md#which-telemetry-does-a-gateway-write-to-disk) explains what's written and how to turn it off.

## October 17, 2026

### New

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
