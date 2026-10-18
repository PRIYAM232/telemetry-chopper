#!/bin/sh
# Enable and start the service on a fresh install; restart it on upgrade if
# it was running. Skipped where systemd isn't running (containers, chroots).
set -e

if [ -d /run/systemd/system ]; then
    systemctl daemon-reload
    if systemctl is-enabled --quiet telemetry-chopper.service 2>/dev/null; then
        # Upgrade: pick up the new binary.
        systemctl try-restart telemetry-chopper.service
    else
        systemctl enable --now telemetry-chopper.service
    fi
fi

cat <<'MSG'

Telemetry Chopper is installed.
  Rules:   /etc/telemetry-chopper/rules.yaml   (edits apply within seconds)
  Config:  /etc/telemetry-chopper/config.yaml  (receivers, exporters)
  Logs:    journalctl -u telemetry-chopper -f
  Metrics: curl -s http://127.0.0.1:8888/metrics | grep chopper_filter
Docs: https://github.com/PRIYAM232/telemetry-chopper/blob/main/docs/deploy/install-the-collector.md

MSG
