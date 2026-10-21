# otelcol-chopper

The Telemetry Chopper collector: an OpenTelemetry Collector that drops, samples, redacts, routes and rate-limits traces, logs and metrics before they reach your observability vendor.

This archive contains:

| File | What it is |
|---|---|
| `otelcol-chopper` | The collector |
| `config.yaml` | Collector configuration: OTLP in on ports 4317 (gRPC) and 4318 (HTTP), rules applied, a summary of each batch printed |
| `rules.yaml` | Example rules. Edit them; changes apply within seconds |
| `LICENSE` | Apache License 2.0 |

## Run it

```bash
CHOPPER_RULES_FILE=./rules.yaml ./otelcol-chopper --config config.yaml
```

Check the configuration and rules without starting:

```bash
CHOPPER_RULES_FILE=./rules.yaml ./otelcol-chopper validate --config config.yaml
```

Then point your applications' OTLP exporters at this machine, and replace the `debug` exporter in `config.yaml` with your backend.

On macOS, if the system blocks the binary because it was downloaded, run `xattr -d com.apple.quarantine otelcol-chopper` once.

## Learn more

- Install as a service with the .deb or .rpm package: https://github.com/PRIYAM232/telemetry-chopper/blob/main/docs/deploy/install-the-collector.md
- Rules file reference: https://github.com/PRIYAM232/telemetry-chopper/blob/main/docs/rules/rules-file.md
