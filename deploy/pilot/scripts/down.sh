#!/usr/bin/env bash
# Stop the pilot rehearsal. Pass --wipe to also delete its data volumes
# (Postgres rules, Tempo/Loki/Prometheus data, the cold-storage archive).
set -euo pipefail
PILOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
args=(down --remove-orphans)
[ "${1:-}" = "--wipe" ] && args+=(--volumes)
docker compose -f "$PILOT_DIR/compose.yaml" "${args[@]}"
