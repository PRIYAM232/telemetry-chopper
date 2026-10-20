# Datadog test harness

Runs Telemetry Chopper in front of a real Datadog account and proves, on the Datadog side, what the rules did.

```
send.py ─OTLP─► Chopper collector ─OTLP gRPC─► Datadog Agent 7.84 ─► Datadog
                    │  rules from the control plane (:3022)
                    └─ ROUTE cold-storage → debug/cold (never leaves the machine)
```

The collector ships no Datadog exporter, so it sends OTLP to a Datadog Agent with OTLP ingest enabled. That Agent is the supported OTLP path into Datadog. The stack runs as compose project `chopper-dd` on its own ports (control plane 3022, OTLP 14427/14428, collector self-metrics 18898), so it doesn't collide with the quick start.

## Run it

```bash
cp deploy/datadog/.env.example deploy/datadog/.env   # then add DD_API_KEY and DD_SITE
deploy/datadog/run.sh up       # build and start (a few minutes the first time)
deploy/datadog/run.sh rules    # add the test rules, wait until the collector enforces them
deploy/datadog/run.sh send     # send one labelled batch; prints its run id
deploy/datadog/run.sh check <run-id>
deploy/datadog/run.sh down     # remove containers, volumes and built images
```

## What gets sent and what Datadog should show

Each `send` posts 20 records per case, all tagged `chopper.test.run:<run-id>` and `chopper.test.case:<case>`, from service `chopper-dd-test` in env `chopper-test`.

| Signal | Case | Rule | In Datadog |
|---|---|---|---|
| Logs | `info-kept` | none | 20 logs |
| Logs | `debug-dropped` | DROP `log.severity` = DEBUG | 0 |
| Logs | `email-redacted` | REDACT `user.email` regex | 20 logs, `@user.email:[REDACTED_PATTERN]` |
| Logs | `healthz-unindexed` | EXCLUDE_INDEX `http.route` contains /healthz | 20 logs with `@chopper.index:false` (0 indexed once you add the exclusion filter below) |
| Logs | `archive-routed` | ROUTE `tier` = archive → cold-storage | 0 (kept local in `debug/cold`) |
| Traces | `checkout-kept` | none | 20 spans |
| Traces | `healthz-dropped` | seeded DROP `http.route` contains /healthz | 0 |
| Traces | `notfound-dropped` | seeded DROP `http.status_code` = 404 | 0 |
| Metrics | `chopper.test.kept` | none | reported |
| Metrics | `chopper.test.noise` | DROP `metric.name` | absent |

Datadog queries:

- Logs: `@chopper.test.run:<run-id>`, grouped by `@chopper.test.case`
- APM spans: `service:chopper-dd-test @chopper.test.run:<run-id>`
- Metrics: `chopper.test.kept` and `chopper.test.noise`
- PII check: `@chopper.test.run:<run-id> alice@example.com` returns nothing

To see EXCLUDE_INDEX save indexing cost, add an exclusion filter `@chopper.index:false` to your log index (Logs → Configuration → Indexes). The /healthz logs then still appear in Live Tail and count toward ingest, but they aren't indexed.

`check` prints the collector's in and out counts, then the Agent's totals since it started: whether Datadog accepted the API key, logs received and sent to Datadog with retries, metric points received, and trace upload errors. With `DD_APP_KEY` set and a run id, it also counts logs and spans per case through the Datadog API. Indexing takes a minute or two.

The Agent doesn't count spans that arrive over OTLP: its APM status shows "No traces received" and zero payloads even while it uploads them. `check` reports trace upload errors instead; count the spans in Datadog (with `DD_APP_KEY`, or in APM under `service:chopper-dd-test`).

## Reference run (real Datadog account, 2026-10-20)

One `send` on a new account (site `datadoghq.com`), Agent 7.84.4:

- Collector: spans 60 received → 20 sent, logs 100 → 60, metric points 2 → 1, 0 send failures.
- Agent: API key valid; 60 logs received and 60 sent to Datadog, 0 retries; 1 metric point received; 0 trace upload errors. With `DD_LOG_LEVEL=debug`, the trace-agent logged one `Flushed traces to the API` per batch.

## Reference run (placeholder API key, 2026-10-20)

Datadog itself can't be checked without a real key. Everything up to the Agent's intake can:

- Collector: spans 60 received → 20 sent, logs 100 → 60, metric points 2 → 1, 0 send failures.
- `agent stream-logs` on the Agent: 60 logs forwarded (info-kept, email-redacted and healthz-unindexed, 20 each), 0 containing the raw email, `user.email` = `[REDACTED_PATTERN]`, healthz logs carry `chopper.index: false`.
