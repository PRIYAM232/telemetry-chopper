# Run gateways in production

A production Telemetry Chopper gateway does two things beyond applying your rules. It sheds load before it runs out of memory, and it keeps the telemetry waiting for your backends on disk, so a crash or restart doesn't lose it. The `otelcol-chopper` distribution includes the components for both. The Helm chart and the [pilot rehearsal environment](../../deploy/pilot/README.md) turn them on.

## The recommended gateway pipeline

```
OTLP receiver ─▶ memory_limiter ─▶ chopper_filter ─▶ routing ─▶ exporters (persistent sending_queue)
```

| Component | What it does |
|---|---|
| `memory_limiter` processor | Refuses incoming data once the gateway's memory use passes a soft limit. Senders get a retryable error and back off instead of the gateway being OOM-killed. |
| `file_storage` extension | Gives exporter queues a directory on disk. |
| Exporter `sending_queue` with `storage: file_storage` | Writes queued batches to disk. After a crash or restart, the gateway sends what was waiting. |
| Exporter `sending_queue.batch` | Batches before sending. Use this instead of the `batch` processor, which the distribution doesn't include. |

## Limit memory use

Put `memory_limiter` first in every pipeline that has a receiver:

```yaml
processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 80
    spike_limit_percentage: 25

service:
  pipelines:
    traces/in:
      receivers: [otlp]
      processors: [memory_limiter, chopper_filter]
      exporters: [routing/traces]
```

The percentages are of the memory limit of the gateway's container. Without a container limit, they're of the host's memory, so always set one. With the values above, the gateway refuses data above 55% of the limit (80% minus 25%) and forces a garbage collection at 80%.

Refused data shows up in the **OTLP receiver refusals /s** panel of the Grafana dashboard, and in the `otelcol_receiver_refused_spans`, `otelcol_receiver_refused_log_records` and `otelcol_receiver_refused_metric_points` metrics. Sustained refusals mean the gateway tier needs more memory or more replicas.

In the Helm chart, set `collector.memoryLimiter` and `collector.resources.limits.memory`.

## Keep queued telemetry across restarts

Enable the `file_storage` extension and point each exporter's queue at it:

```yaml
extensions:
  file_storage:
    directory: /var/lib/otelcol/file_storage
    timeout: 1s
    compaction:
      on_start: true
      on_rebound: true
      directory: /var/lib/otelcol/file_storage

exporters:
  otlp_grpc/backend:
    endpoint: backend:4317
    sending_queue:
      storage: file_storage
      batch:
        flush_timeout: 1s

service:
  extensions: [file_storage]
```

The `otelcol-chopper` image creates `/var/lib/otelcol/file_storage`, writable by the user the collector runs as (uid 65532). Each gateway needs its own directory. Two gateways can't share one.

How long the queue survives depends on where the directory lives:

| Directory | Survives a crash and restart | Survives the container or pod being recreated |
|---|---|---|
| The image's directory (Docker, no volume) | ✓ | |
| Kubernetes `emptyDir` (Helm chart default) | ✓ | |
| A volume per gateway (Docker named volume, Kubernetes PVC) | ✓ | ✓ |

In the Helm chart, `collector.persistentQueue` turns persistent queues on for the archive exporters. It's on by default, with an `emptyDir` volume.

## Considerations

- A persistent queue holds what the gateway accepted but hasn't sent. Data inside the gateway's processors when it crashes is still lost. Senders whose requests weren't acknowledged retry them.
- A queue's capacity is counted in requests (1,000 by default). When the queue is full, the gateway refuses new data, just like the memory limiter does.
- Writing to disk adds latency to every export. Use fast local disks.
- Queued telemetry is stored on the gateway's disk, unencrypted, until it's sent. See [Which telemetry does a gateway write to disk?](#which-telemetry-does-a-gateway-write-to-disk)

## Frequently asked questions

### Which telemetry does a gateway write to disk?

Only what you configure it to write. `chopper_filter` keeps rulesets and counters in memory and never writes to disk. Telemetry reaches a gateway's disk in two ways:

- **Persistent exporter queues.** Batches waiting to be sent stay in the `file_storage` directory until they're delivered. The queue comes after `chopper_filter`, so your rules, including REDACT, have already been applied. The `file_storage` extension doesn't encrypt its files.
- **The `file` exporter**, if a pipeline uses it to archive telemetry.

The `debug` exporter at `detailed` verbosity and `log_span_details: true` also print telemetry to the collector's log, which your container runtime may keep on disk. Leave both off in production. The Helm chart does.

To keep telemetry off a gateway's disk, turn persistent queues off: set `collector.persistentQueue.enabled: false` in the Helm chart, or remove `storage: file_storage` from your exporters. Queued telemetry is then held in memory only and is lost if the gateway crashes. To keep persistent queues and protect what they hold, put the queue directory on an encrypted disk or volume.

### Why isn't the batch processor included?

Exporters batch in their own sending queue (`sending_queue.batch`), which upstream recommends instead of the `batch` processor. It also batches data that a persistent queue reloads after a restart.

### How was this tested?

With a gateway's backend down, a gateway that was SIGKILLed while holding 2,148 spans delivered all 2,148 after restarting, with no duplicates. With in-memory queues it delivered none. In the [pilot rehearsal](../../deploy/pilot/README.md#reference-results), a gateway killed during a Tempo outage delivered all 2,756 spans it held once Tempo was back. Under a flood into a 128 MB container, a gateway without `memory_limiter` was OOM-killed within 5 seconds. With it, the gateway stayed up and refused data.

### Does the memory limiter work with several gateway replicas?

Yes. Each gateway limits its own memory. Senders that retry, such as a collector's OTLP or `loadbalancing` exporter, resend refused data later.
