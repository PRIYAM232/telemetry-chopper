#!/bin/sh
# Forget the removed unit. The telemetry-chopper account and the files in
# /etc/telemetry-chopper are kept (dpkg --purge removes the config files).
set -e

if [ -d /run/systemd/system ]; then
    systemctl daemon-reload >/dev/null 2>&1 || true
fi
