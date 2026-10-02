#!/usr/bin/env bash
# Start the pilot rehearsal environment.
#
#   deploy/pilot/scripts/up.sh            # fetch the demo (first run), build, start
#   deploy/pilot/scripts/up.sh --no-build # start without rebuilding Chopper images
#
# The OpenTelemetry Demo is fetched at a pinned release into deploy/pilot/.demo
# (git-ignored), so the rehearsal always runs the same application code.
set -euo pipefail

DEMO_REF="${DEMO_REF:-3.1.0}"
PILOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_DIR="$PILOT_DIR/.demo"

if [ ! -f "$DEMO_DIR/compose.yaml" ]; then
  echo "Fetching OpenTelemetry Demo $DEMO_REF ..."
  git clone --quiet --depth 1 --branch "$DEMO_REF" \
    https://github.com/open-telemetry/opentelemetry-demo "$DEMO_DIR"
fi

compose=(docker compose -f "$PILOT_DIR/compose.yaml")

# Build only Telemetry Chopper's images from this checkout. The demo's
# services also declare build sections, but their published images are
# pinned in demo.env; building them from source takes the better part of
# an hour.
if [ "${1:-}" != "--no-build" ]; then
  "${compose[@]}" build control-plane-migrate control-plane chopper-gateway
fi

"${compose[@]}" up -d --pull missing --no-build

cat <<MSG

Pilot rehearsal is starting. Allow a minute or two for every service.

  Astronomy Shop (demo app)   http://localhost:8180
  Load generator (Locust)     http://localhost:8180/loadgen/
  Feature flags (flagd UI)    http://localhost:8180/feature
  Telemetry Chopper           http://localhost:${CHOPPER_UI_PORT:-3300}/dashboard
  Grafana                     http://localhost:${GRAFANA_PORT:-3301}
  Prometheus                  http://localhost:${PROMETHEUS_PORT:-9390}

Stop with deploy/pilot/scripts/down.sh
MSG
