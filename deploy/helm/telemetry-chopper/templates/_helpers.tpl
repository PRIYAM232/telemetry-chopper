{{/*
Common labels stamped on every resource. Per-component selector labels are
declared inline in each template (they must stay stable — selectors are
immutable on Deployments/StatefulSets).
*/}}
{{- define "telemetry-chopper.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: telemetry-chopper
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}

{{/*
The database connection URL. database.externalUrl (RDS/Cloud SQL) wins;
otherwise the URL is assembled against the in-chart postgres Service.
Single source of truth for the secret, the migration job, and anything else
that needs the DB.
*/}}
{{- define "telemetry-chopper.databaseUrl" -}}
{{- if .Values.database.externalUrl -}}
{{- .Values.database.externalUrl -}}
{{- else -}}
postgresql://{{ .Values.postgres.auth.username }}:{{ .Values.postgres.auth.password }}@{{ .Release.Name }}-postgres:5432/{{ .Values.postgres.auth.database }}?schema=public
{{- end -}}
{{- end }}

{{/*
Control-plane base URL as seen from inside the cluster (the collector's
chopper_filter sync/stats endpoints hang off this).
*/}}
{{- define "telemetry-chopper.controlPlaneUrl" -}}
http://{{ .Release.Name }}-control-plane:{{ .Values.controlPlane.service.port }}
{{- end }}

{{/*
Exporter list for one cold pipeline (pass the signal name: traces, logs or
metrics). The enabled collector.coldStorage archive exporters, or debug/cold
when none is enabled. Also fails the render early on incomplete archive
settings, so a misconfigured release never reaches the cluster.
*/}}
{{- define "telemetry-chopper.coldExporters" -}}
{{- $cs := .root.Values.collector.coldStorage -}}
{{- $out := list -}}
{{- if $cs.s3.enabled -}}
{{- if not $cs.s3.bucket }}{{ fail "collector.coldStorage.s3.enabled requires collector.coldStorage.s3.bucket" }}{{ end -}}
{{- $out = append $out "awss3/archive" -}}
{{- end -}}
{{- if $cs.azureBlob.enabled -}}
{{- if and (ne (toString $cs.azureBlob.auth.type) "connection_string") (not $cs.azureBlob.url) }}{{ fail "collector.coldStorage.azureBlob.url is required unless auth.type is connection_string" }}{{ end -}}
{{- $out = append $out "azure_blob/archive" -}}
{{- end -}}
{{- if $cs.file.enabled -}}
{{- if not $cs.file.volume }}{{ fail "collector.coldStorage.file.enabled requires collector.coldStorage.file.volume (e.g. nfs or persistentVolumeClaim)" }}{{ end -}}
{{- $out = append $out (printf "file/archive-%s" .signal) -}}
{{- end -}}
{{- if not $out -}}
{{- $out = list "debug/cold" -}}
{{- end -}}
[{{ join ", " $out }}]
{{- end }}

{{/*
ServiceAccount name for the collector pods.
*/}}
{{- define "telemetry-chopper.collectorServiceAccountName" -}}
{{- if .Values.collector.serviceAccount.create -}}
{{- default (printf "%s-collector" .Release.Name) .Values.collector.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.collector.serviceAccount.name -}}
{{- end -}}
{{- end }}
