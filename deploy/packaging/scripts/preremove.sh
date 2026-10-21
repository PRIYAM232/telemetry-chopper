#!/bin/sh
# Stop and disable the service when the package is removed, not when it's
# upgraded. dpkg passes "remove" or "upgrade"; rpm passes the number of
# versions left after the operation (0 = removal).
set -e

case "$1" in
    remove|purge|0)
        if [ -d /run/systemd/system ]; then
            systemctl disable --now telemetry-chopper.service >/dev/null 2>&1 || true
        fi
        ;;
esac
