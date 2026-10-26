#!/bin/sh
# homebrew module: 01-telemetry-off
# Masks and stops Samsung's ad/telemetry daemons at every boot.
#
# Why mask --runtime: the units live on the read-only root image with
# Restart=always, and /run/systemd/system is tmpfs, so a plain stop just
# respawns. The boot-time module runner re-applies this every boot.
#
# Vendor opt-out switches (negated ConditionPathExists in the unit files):
# touching the matching path under /opt/usr/share/systemd/system keeps
# the unit from starting at all — persistent across reboots.
#
# Disabled state: touch <module dir>/disabled
# Undo: systemctl unmask --runtime <unit>; systemctl start <unit>
MODULE_DIR=${MODULE_DIR:-/opt/usr/share/selfroot/modules/01-telemetry-off}
EVIDENCE=${EVIDENCE:-/home/owner/share/tmp/sdk_tools/selfroot-evidence}

# Vendor opt-out flags (persistent under /opt).
OPTOUT=/opt/usr/share/systemd/system
mkdir -p $OPTOUT 2>/dev/null
for o in pisa-service canalysis-daemon slive-provider-daemon \
         com.samsung.tv.context-aware-agent \
         com.samsung.tv.context-aware-service; do
    touch $OPTOUT/$o 2>/dev/null
done

# Runtime mask + stop.
for u in adagent-service \
         pisa-service \
         canalysis-service \
         slive-provider-daemon \
         contents-recognition-service \
         com.samsung.tv.context-aware-agent \
         com.samsung.tv.context-aware-service \
         com.samsung.tv.cis-api-service-app; do
    systemctl mask --runtime "$u.service" >/dev/null 2>&1
    systemctl stop "$u.service" >/dev/null 2>&1 &
done
wait

# Report results.
for u in adagent-service \
         pisa-service \
         canalysis-service \
         slive-provider-daemon \
         contents-recognition-service \
         com.samsung.tv.context-aware-agent \
         com.samsung.tv.context-aware-service \
         com.samsung.tv.cis-api-service-app; do
    printf '%s -> %s\n' "$u" "$(systemctl is-active "$u.service" 2>&1)"
done
exit 0
