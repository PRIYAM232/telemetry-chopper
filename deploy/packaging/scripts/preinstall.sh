#!/bin/sh
# Create the unprivileged account the service runs as. Idempotent, so
# upgrades and reinstalls are no-ops.
set -e

if ! getent group telemetry-chopper >/dev/null 2>&1; then
    groupadd --system telemetry-chopper
fi
if ! getent passwd telemetry-chopper >/dev/null 2>&1; then
    useradd --system --gid telemetry-chopper --no-create-home \
        --home-dir /var/lib/telemetry-chopper --shell /usr/sbin/nologin \
        --comment "Telemetry Chopper collector" telemetry-chopper
fi
