# Filter traces from Datadog tracing libraries

Services instrumented with Datadog's tracing libraries (`dd-trace-java`, `dd-trace-py`, `dd-trace-js`, `dd-trace-go`, `dd-trace-dotnet`, `dd-trace-rb` and `dd-trace-php`) send traces to the Datadog Agent in Datadog's own format, not OpenTelemetry. `otelcol-chopper` includes a **Datadog receiver** that accepts that format on the Agent's trace port, 8126. Put Telemetry Chopper between those services and the Datadog Agent, and your rules drop, sample, redact and rate-limit their spans the same way they do OpenTelemetry spans. You don't change any application code.

## How it works

```
Services with Datadog tracing libraries
        │ Datadog trace API, :8126
        ▼
otelcol-chopper:  datadog receiver ─▶ chopper_filter (your rules) ─▶ transform/datadog
        │ OTLP gRPC
        ▼
Datadog Agent with OTLP ingest  ─▶  Datadog APM
```

1. The **datadog receiver** turns each Datadog span into an OpenTelemetry span. It keeps the operation name (for example `flask.request`) as the span name, the resource (for example `GET /checkout`) in the `dd.span.Resource` attribute, and the tracer's sampling decision in `sampling.priority`.
2. Your **rules** run on the converted spans. See [Write rules for Datadog spans](#write-rules-for-datadog-spans).
3. The **`transform/datadog`** step copies the operation name and resource into `operation.name` and `resource.name`. The Datadog Agent uses these attributes, so the spans keep the names they had in Datadog APM. Without this step, the Agent would derive new ones, renaming `flask.request` to `http.server.request`.
4. The **Datadog Agent** receives the spans over OTLP, computes APM trace metrics from them, applies your tracers' sampling decisions and sends them to Datadog.

## Before you begin

- A Datadog Agent 7 with APM and OTLP ingest turned on, for example with `DD_APM_ENABLED=true` and `DD_OTLP_CONFIG_RECEIVER_PROTOCOLS_GRPC_ENDPOINT=0.0.0.0:4317`. Telemetry Chopper is tested with Agent 7.84.
- Port 8126 free where the collector runs. If a Datadog Agent runs on the same host, run the collector elsewhere or give one of them another port.
- A list of the Datadog features your services use besides tracing. Only traces pass through Telemetry Chopper. See [Considerations](#considerations) before you move a service that uses Continuous Profiler, Data Streams Monitoring, Dynamic Instrumentation or remote configuration.

## Send Datadog traces through Telemetry Chopper

### With the Helm chart

1. Turn on the Datadog receiver, and point the collector at your Datadog Agent's OTLP port:

   ```bash
   helm upgrade --install chopper deploy/helm/telemetry-chopper \
     --reuse-values \
     --set collector.datadogReceiver.enabled=true \
     --set collector.hotBackend.otlp.endpoint=datadog-agent.datadog.svc.cluster.local:4317
   ```

   The collector Service now also listens on port 8126, named `datadog-apm`.

2. In each service you want to filter, set the tracer's Agent URL to the collector Service:

   ```bash
   DD_TRACE_AGENT_URL=http://chopper-collector.<namespace>.svc.cluster.local:8126
   ```

   `DD_TRACE_AGENT_URL` takes precedence over `DD_AGENT_HOST` and `DD_TRACE_AGENT_PORT`.

3. Restart the services.

### With your own collector configuration

Add the receiver and the transform step to your traces pipeline, after `chopper_filter`:

```yaml
receivers:
  datadog:
    endpoint: 0.0.0.0:8126

processors:
  transform/datadog:
    error_mode: ignore
    trace_statements:
      - set(span.attributes["operation.name"], span.name) where span.attributes["dd.span.Resource"] != nil and span.attributes["operation.name"] == nil
      - set(span.attributes["resource.name"], span.attributes["dd.span.Resource"]) where span.attributes["dd.span.Resource"] != nil and span.attributes["resource.name"] == nil

exporters:
  otlp_grpc/datadog-agent:
    endpoint: datadog-agent:4317
    tls:
      insecure: true

service:
  pipelines:
    traces/in:
      receivers: [otlp, datadog]
      processors: [memory_limiter, chopper_filter, transform/datadog]
      exporters: [routing/traces]
```

The transform step only changes spans that came from a Datadog tracing library: those are the spans with `dd.span.Resource`. Add the datadog receiver to traces pipelines only. See [Can I send logs and metrics from the Datadog Agent through Telemetry Chopper?](#can-i-send-logs-and-metrics-from-the-datadog-agent-through-telemetry-chopper)

### Check that traces flow

- The collector's `otelcol_receiver_accepted_spans{receiver="datadog"}` metric counts the Datadog spans it accepts, and the rule cards on the dashboard count what each rule matched and dropped.
- In Datadog, go to **APM → Traces** and search for your service. Operation names, resources and environments should be the same as before.
- The Datadog Agent's `agent status` shows **No traces received** in its APM section even while traces flow. It doesn't count spans that arrive over OTLP.

## Write rules for Datadog spans

Rules see the converted spans. The receiver renames common Datadog tags to their OpenTelemetry names, so write conditions with the OpenTelemetry name:

| Datadog tag | Use in rules |
|---|---|
| `http.status_code` | `http.response.status_code` |
| `http.method` | `http.request.method` |
| `http.url` | `url.full` |
| `http.useragent` | `user_agent.original` |
| `http.client_ip` | `client.address` |
| `db.statement` | `db.query.text` |
| `db.type` | `db.system.name` |
| `error.msg` | `exception.message` |
| `env` | `deployment.environment.name` |
| `service` | `service.name` (a resource attribute) |
| resource name | `dd.span.Resource` |

Other tags, such as `http.route`, `user.email` and your own custom tags, keep their names.

For example:

| Goal | Condition |
|---|---|
| Drop health-check requests | `http.route` `CONTAINS` `/healthz` |
| Drop one endpoint by its Datadog resource | `dd.span.Resource` `EQUALS` `GET /ping` |
| Drop 404 responses | `http.response.status_code` `EQUALS` `404` |
| Mask emails in a tag | REDACT `user.email` `REGEX_MATCH` `[^@\s]+@[^@\s]+` |

A REDACT rule on `dd.span.Resource` also masks the resource name Datadog shows, because the transform step copies the redacted value.

## What Datadog shows

| Span field in Datadog | Result |
|---|---|
| Service, environment, version | Same as before. |
| Operation name and resource | Same as before, through the transform step. |
| Span type | Rebuilt by the Agent: `web` for server spans, `http` for client spans, and database types such as `sql` or `redis` from `db.system`. Other types, such as `cache` or `template`, become the default for their span kind. |
| Trace metrics (`trace.<operation>.hits`, errors, latency) | Computed by the Agent from the spans it receives. Spans your rules drop aren't counted. |
| Unsampled traces | Your tracers still send every trace, and the Agent drops the ones they didn't keep after computing trace metrics, as it does without Telemetry Chopper. They don't add to your indexed spans. |

## Considerations

- **Only traces pass through Telemetry Chopper.** The receiver answers every other request on port 8126 with success and discards it. A service pointed at the collector loses its Continuous Profiler profiles, Data Streams Monitoring, Dynamic Instrumentation snapshots and remote configuration. Keep those services pointed at the Agent, or turn those features off for them. Runtime metrics (DogStatsD, port 8125) and logs collected by the Agent don't use port 8126 and are unaffected.
- **Trace metrics change with your rules.** A DROP, SAMPLE or THROTTLE rule on real traffic lowers the request counts and error rates Datadog shows for the service, because the Agent computes them from what it receives. Dropping health checks is usually what you want. For sampling, see [Sample whole traces](../rules/README.md#sample-whole-traces).
- **DROP removes matching spans only.** Child spans of a dropped span, such as the database query inside a health check, still reach Datadog without their parent. To remove whole traces, match a tag that every span of those traces carries.
- **Some tags change names.** Datadog tags the receiver renames, such as `http.status_code`, appear in Datadog under their OpenTelemetry names. Update monitors and facets that use the old names.
- The Datadog receiver is an alpha component of the OpenTelemetry Collector.

## Frequently asked questions

### Do I need to change my application code?

No. Change the tracer's Agent URL (`DD_TRACE_AGENT_URL`) and restart the service.

### Will my Datadog monitors and dashboards keep working?

Monitors on trace metrics keep working, because operation names, resources and services stay the same. Their values change when your rules drop or sample traffic. Monitors and facets that use tags the receiver renames, such as `@http.status_code`, need the new names.

### Can I use OpenTelemetry and Datadog tracing libraries on the same collector?

Yes. The collector takes OpenTelemetry on 4317 and 4318 and Datadog traces on 8126, and the same rules apply to both. The transform step changes only spans that came from a Datadog tracing library.

### Can I send logs and metrics from the Datadog Agent through Telemetry Chopper?

Not yet. The datadog receiver can also accept the Agent's logs and metrics, but Telemetry Chopper doesn't support or test that path. Add the receiver to traces pipelines only.

### How do I test this before changing production services?

The [Datadog test harness](../../deploy/datadog/README.md) runs Telemetry Chopper in front of your Datadog account and sends traces with Datadog's Python tracing library: `run.sh send-ddtrace`.
