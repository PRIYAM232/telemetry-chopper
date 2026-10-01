# Telemetry Chopper on Kubernetes — `telemetry-chopper` Helm chart

Phase 9: the docker-compose stack (`deploy/docker`) as a Helm release.
Phase 10 adds self-monitoring (collector metrics on :8888, ServiceMonitor,
Grafana dashboard — see [Self-monitoring](#self-monitoring-phase-10)).

```
deploy/helm/telemetry-chopper/
├── Chart.yaml
├── values.yaml
├── files/
│   └── chopper-collector-dashboard.json  # Grafana dashboard (inlined by .Files.Get)
└── templates/
    ├── _helpers.tpl              # labels, DATABASE_URL + control-plane URL helpers
    ├── secret.yaml               # DATABASE_URL for the control plane
    ├── configmap-collector.yaml  # otelcol-k8s.yaml pipeline config
    ├── postgres.yaml             # StatefulSet + PVC template + headless Service
    ├── migration-job.yaml        # prisma migrate deploy + db seed (Helm hook)
    ├── control-plane.yaml        # Next.js Deployment + Service :3000
    ├── collector.yaml            # otelcol-chopper Deployment + Service :4317/:4318/:8888 (+ optional ServiceAccount)
    ├── servicemonitor.yaml       # Prometheus Operator scrape config (gated)
    ├── dashboard-configmap.yaml  # Grafana sidecar dashboard (gated)
    └── NOTES.txt
```

Startup order, mirroring compose: postgres (ready) → migrate+seed (hook Job)
→ control plane → collector. On **first install** the migration Job runs as a
`post-install` hook (a `pre-install` hook would fire before the in-chart
postgres exists); on **upgrades** it runs `pre-upgrade`, so migrations always
complete before new app pods roll out. Resource names derive from the release
name — install as `chopper` to get the `chopper-control-plane` / `chopper-collector`
/ `chopper-postgres` DNS names the collector config expects.

## 1. Build the images

From the repo root (same builds the compose stack uses):

```sh
docker build -t telemetry-chopper/control-plane:dev         --target runner  control-plane/
docker build -t telemetry-chopper/control-plane-migrate:dev --target builder control-plane/
docker build -t telemetry-chopper/otelcol-chopper:dev -f deploy/docker/Dockerfile.collector .
```

## 2. Load them into a local cluster

kind:

```sh
kind create cluster --name chopper
kind load docker-image --name chopper \
  telemetry-chopper/control-plane:dev telemetry-chopper/control-plane-migrate:dev telemetry-chopper/otelcol-chopper:dev
```

minikube:

```sh
minikube start
minikube image load telemetry-chopper/control-plane:dev
minikube image load telemetry-chopper/control-plane-migrate:dev
minikube image load telemetry-chopper/otelcol-chopper:dev
```

## 3. Install

```sh
helm lint deploy/helm/telemetry-chopper
helm install chopper deploy/helm/telemetry-chopper --namespace chopper --create-namespace
kubectl -n chopper get pods -w
```

Expected steady state: `chopper-postgres-0`, `chopper-control-plane-*`, and
`chopper-collector-*` Running/Ready; `chopper-migrate-*` Completed.

## 4. Test

```sh
# migrations + seeded dev fleet
kubectl -n chopper logs job/chopper-migrate

# dashboard
kubectl -n chopper port-forward svc/chopper-control-plane 3000:3000
open http://localhost:3000/dashboard

# OTLP smoke test through the collector
kubectl -n chopper port-forward svc/chopper-collector 4318:4318
curl -sS -X POST http://localhost:4318/v1/traces \
  -H 'Content-Type: application/json' \
  -d '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"helm-smoke-test"}}]},"scopeSpans":[{"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174","name":"smoke","kind":1,"startTimeUnixNano":"1750000000000000000","endTimeUnixNano":"1750000001000000000"}]}]}]}'

# chopper_filter batch observations + debug exporter output
kubectl -n chopper logs deploy/chopper-collector -f
```

Scale the data plane:

```sh
helm upgrade chopper deploy/helm/telemetry-chopper -n chopper --reuse-values --set collector.replicas=3
```

## Self-monitoring (Phase 10)

Every collector pod serves its own metrics — Prometheus text format on
`:8888/metrics`, exposed as the `metrics` port on the pod and the
`chopper-collector` Service. Alongside the stock `otelcol_*` process/pipeline
metrics, the `chopper_filter` engine registers:

| Metric | Type | Meaning |
| --- | --- | --- |
| `otelcol_chopper_filter_rules` | gauge | rules in the currently synced ruleset (0 until first sync) |
| `otelcol_chopper_filter_spans_received` / `_dropped` | counter | spans in / removed by rules |
| `otelcol_chopper_filter_logs_received` / `_dropped` | counter | log records in / removed |
| `otelcol_chopper_filter_metrics_received` / `_dropped` | counter | metrics in / removed |
| `otelcol_chopper_filter_rule_matched` / `_rule_dropped` | counter | records each rule matched / removed, labelled `rule_id`, `rule_name`, `signal`, `action` (one series per synced rule) |

Counters are cumulative since process start (Prometheus `rate()` material) —
unlike the control-plane heartbeat, which reports interval deltas. The
chart's telemetry reader pins classic collector names (`without_type_suffix`
etc.), so there is no `_total` suffix.

Discovery is opt-in, off by default:

```sh
helm upgrade chopper deploy/helm/telemetry-chopper -n chopper --reuse-values \
  --set metrics.serviceMonitor.enabled=true \
  --set 'metrics.serviceMonitor.additionalLabels.release=kube-prometheus-stack' \
  --set metrics.dashboard.enabled=true
```

- `metrics.serviceMonitor.enabled` — a `monitoring.coreos.com/v1`
  ServiceMonitor scraping every collector pod on the `metrics` port.
  Requires the Prometheus Operator CRDs; match `additionalLabels` to your
  Prometheus instance's `serviceMonitorSelector` (kube-prometheus-stack
  defaults to `release: <its-release-name>`).
- `metrics.dashboard.enabled` — a ConfigMap labelled `grafana_dashboard: "1"`
  carrying `files/chopper-collector-dashboard.json`; Grafana's dashboard
  sidecar imports it automatically. Use `metrics.dashboard.namespace` if the
  sidecar only watches its own namespace, and the `grafana_folder`
  annotation for folder routing.

### Simulating a Prometheus scrape against kind

After rebuilding + `kind load`-ing the collector image (the self-metrics are
compiled into the binary) and upgrading the release:

```sh
# 1. Exactly what Prometheus does — hit one pod's :8888 from inside the
#    cluster (ServiceMonitor scrapes pod endpoints, never the ClusterIP):
POD_IP=$(kubectl -n chopper get pod -l app.kubernetes.io/name=chopper-collector \
  -o jsonpath='{.items[0].status.podIP}')
kubectl -n chopper run scrape-sim --rm -it --restart=Never \
  --image=curlimages/curl -- curl -s "http://${POD_IP}:8888/metrics"

# 2. Or from the workstation:
kubectl -n chopper port-forward deploy/chopper-collector 8888:8888
curl -s localhost:8888/metrics | grep chopper_filter

# 3. Push a span through OTLP (see the smoke test above), re-scrape, and
#    watch otelcol_chopper_filter_spans_received climb. With the seeded dev
#    fleet's rules enabled in the dashboard, otelcol_chopper_filter_rules
#    goes non-zero within one sync interval (10s).
```

Every pod behind the Service is scraped individually; `kubectl -n chopper get
endpoints chopper-collector` lists the addresses Prometheus will target.

## Archiving to cold storage

By default the `traces/cold`, `logs/cold` and `metrics/cold` pipelines (everything
a ROUTE rule sends to `cold-storage`) end in the `debug` exporter. Enable any
combination of `collector.coldStorage.s3`, `.azureBlob` and `.file` to archive
that data instead. Every enabled exporter receives all cold data. See
[Archiving to cold storage](../../README.md#archiving-to-cold-storage) in the main
README for how each target reaches its archive tier and the caveats (all
three exporters are alpha upstream).

**S3 Glacier on EKS**, with IRSA credentials:

```yaml
collector:
  serviceAccount:
    create: true
    annotations: { eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/chopper-archive }
  coldStorage:
    s3: { enabled: true, region: us-east-1, bucket: acme-audit-archive, storageClass: DEEP_ARCHIVE }
```

The role needs `s3:PutObject` on the bucket. Off EKS, put `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` in a Secret and pass it with `collector.extraEnvFrom`.

**Azure Blob on AKS**, with workload identity (add a lifecycle management rule on
the storage account to move blobs to the Archive tier):

```yaml
collector:
  serviceAccount:
    create: true
    annotations: { azure.workload.identity/client-id: <managed-identity-client-id> }
  podLabels: { azure.workload.identity/use: "true" }
  coldStorage:
    azureBlob:
      enabled: true
      url: https://acmeaudit.blob.core.windows.net/
      auth: { type: workload_identity }
      containers: { traces: audit-traces, logs: audit-logs, metrics: audit-metrics }
```

The containers must already exist, and the identity needs the *Storage Blob
Data Contributor* role on them. To use a connection string instead, keep it in a
Secret and reference it as an environment variable, so it never lands in the
ConfigMap:

```yaml
collector:
  extraEnvFrom: [{ secretRef: { name: chopper-archive-azure } }]   # has AZURE_STORAGE_CONNECTION_STRING
  coldStorage:
    azureBlob:
      enabled: true
      auth: { type: connection_string, connection_string: "${env:AZURE_STORAGE_CONNECTION_STRING}" }
```

**NAS or PVC**, with the file exporter. Each pod writes `traces-<pod>.jsonl`,
`logs-<pod>.jsonl` and `metrics-<pod>.jsonl` under `mountPath`, so replicas can
share one `ReadWriteMany` volume without writing to the same file:

```yaml
collector:
  podSecurityContext: { fsGroup: 65532 }   # lets the non-root collector write to a PVC
  coldStorage:
    file:
      enabled: true
      volume: { nfs: { server: nas.internal, path: /exports/telemetry } }
      # or: volume: { persistentVolumeClaim: { claimName: chopper-archive } }
```

NFS ignores `fsGroup`, so make the export writable by uid/gid 65532 on the NAS
side. With `collector.replicas` > 1, the volume must be `ReadWriteMany` (NFS
is); a `ReadWriteOnce` PVC only works when every replica lands on the same
node. A new pod gets a new name, so a restarted pod starts new files instead of
appending to the old ones.

The chart stops `helm install` with a clear error if an enabled archive is
missing its bucket, storage URL (unless you use a connection string) or volume.

## Real environments

- **Cold storage**: see [Archiving to cold storage](#archiving-to-cold-storage).
- **Managed database**: `--set postgres.enabled=false --set database.externalUrl=postgresql://…` —
  drops the StatefulSet entirely; secret, migration job, and control plane
  all follow the external URL.
- **Fleet credentials**: defaults are the deterministic dev seed values —
  rotate `fleet.id` / `fleet.key` (and set `migrator.seed=false`) for any
  real deployment.
- **External producers**: `--set collector.service.type=LoadBalancer` to
  expose OTLP 4317/4318 outside the cluster.

Teardown: `helm uninstall chopper -n chopper` (PVC survives; `kubectl -n chopper
delete pvc data-chopper-postgres-0` to drop the data), then
`kind delete cluster --name chopper`.
