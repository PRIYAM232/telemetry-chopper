#!/usr/bin/env bash
# Datadog test harness driver. Usage: deploy/datadog/run.sh up|rules|send|check [run-id]|down
# Reads DD_API_KEY / DD_SITE (and optionally DD_APP_KEY for `check`) from
# deploy/datadog/.env or the environment.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/.env" ] && set -a && . "$HERE/.env" && set +a
DD_SITE="${DD_SITE:-datadoghq.com}"
compose() {
  docker compose -p chopper-dd --project-directory "$HERE" \
    -f "$HERE/../docker/docker-compose.yaml" -f "$HERE/compose.yaml" "$@"
}
psql_cp() { docker exec -i chopper-dd-postgres psql -U chopper -d chopper_control -v ON_ERROR_STOP=1 "$@"; }
metric() { # sum of a collector self-metric, optional label filter regex
  curl -s 127.0.0.1:18898/metrics | grep -E "^$1[{ ]" | grep -E "${2:-.}" | awk '{s+=$NF} END {print s+0}'
}
agent_metric() { # sum of a Datadog Agent internal telemetry counter
  docker exec chopper-dd-agent curl -s localhost:5000/telemetry | grep -E "^$1[{ ]" | awk '{s+=$NF} END {print s+0}'
}
agent_stat() { # a "Name: value" line from agent status, e.g. LogsSent
  docker exec chopper-dd-agent agent status 2>/dev/null | awk -v k="$1:" '$1 == k {print $2; exit}'
}

case "${1:-}" in
  up)
    : "${DD_API_KEY:?set DD_API_KEY in $HERE/.env}"
    compose up -d --build --wait
    ;;
  rules)
    psql_cp < "$HERE/rules.sql"
    echo "waiting for the collector to load the rules..."
    until docker logs chopper-dd-collector 2>&1 | grep -q '"rules_total": 8'; do sleep 1; done
    docker logs chopper-dd-collector 2>&1 | grep '"rules_total": 8' | tail -1
    ;;
  send)
    python3 "$HERE/send.py" "${2:-}"
    ;;
  check)
    echo "== Collector (in: received, out: sent to Datadog Agent)"
    for s in spans log_records metric_points; do
      printf '  %-14s received %-6s sent to datadog %s\n' "$s" \
        "$(metric otelcol_receiver_accepted_$s)" \
        "$(metric otelcol_exporter_sent_$s 'otlp_grpc/datadog')"
    done
    printf '  %-14s %s\n' "send failures" "$(metric 'otelcol_exporter_send_failed_(spans|log_records|metric_points)' 'otlp_grpc/datadog')"
    echo "== Datadog Agent (totals since it started)"
    docker exec chopper-dd-agent agent status 2>/dev/null | grep -m1 -E 'API key ending with .*:' | sed -E 's/^ */  /'
    printf '  %-14s received %-6s sent to datadog %s (retries %s)\n' logs \
      "$(agent_metric runtime__datadog_agent_otlp_logs_events)" "$(agent_stat LogsSent)" "$(agent_stat RetryCount)"
    printf '  %-14s received %s\n' metric_points "$(agent_metric runtime__datadog_agent_otlp_metrics_events)"
    # The Agent's APM status and counters don't count spans that arrive over
    # OTLP (they stay at 0 / "No traces received"), so report upload errors
    # instead and count spans in Datadog.
    printf '  %-14s not counted by the Agent; upload errors %s\n' spans \
      "$(docker logs chopper-dd-agent 2>&1 | grep '| TRACE |' | grep -c -E '\| (ERROR|WARN) \|.*pkg/trace/writer' || true)"
    if [ -z "${DD_APP_KEY:-}" ] || [ -z "${2:-}" ]; then
      echo "  To count spans per case, set DD_APP_KEY and pass a run id, or search APM for service:chopper-dd-test"
    fi
    if [ -n "${2:-}" ] && [ -n "${DD_APP_KEY:-}" ]; then
      echo "== Datadog API (run $2, last 30 min; indexing can lag 1-2 min)"
      for kind in logs spans; do
        curl -s -X POST "https://api.$DD_SITE/api/v2/$kind/analytics/aggregate" \
          -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" -H 'Content-Type: application/json' \
          -d "{\"compute\":[{\"aggregation\":\"count\"}],\"filter\":{\"query\":\"@chopper.test.run:$2\",\"from\":\"now-30m\",\"to\":\"now\"},\"group_by\":[{\"facet\":\"@chopper.test.case\"}]}" \
          | python3 -c 'import json,sys; d=json.load(sys.stdin); b=d.get("data",{}).get("buckets",[]); print("  '"$kind"':", {x["by"]["@chopper.test.case"]: x["computes"]["c0"] for x in b} if b or "data" in d else d)'
      done
      printf '  logs still containing the raw email: '
      curl -s -X POST "https://api.$DD_SITE/api/v2/logs/analytics/aggregate" \
        -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" -H 'Content-Type: application/json' \
        -d "{\"compute\":[{\"aggregation\":\"count\"}],\"filter\":{\"query\":\"@chopper.test.run:$2 @user.email:*alice*\",\"from\":\"now-30m\",\"to\":\"now\"}}" \
        | python3 -c 'import json,sys; b=json.load(sys.stdin).get("data",{}).get("buckets",[]); print(b[0]["computes"]["c0"] if b else 0)'
    fi
    ;;
  down)
    compose down -v --rmi local
    ;;
  *) sed -n 2,4p "$0"; exit 1 ;;
esac
