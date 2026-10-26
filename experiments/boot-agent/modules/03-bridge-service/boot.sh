#!/bin/sh
# homebrew module: 03-bridge-service
# Runs the token-gated SDB bridge relay as a supervised systemd service.
#
# The relay reads a 32-character hex token from bridge.conf, requires it
# at the start of each connection, then forwards to 127.0.0.1:26101.
# Default port is 26103.
#
# Requires TvRootBridgeRelay.dll staged at the module dir.
# Token must exist at /opt/usr/share/selfroot/bridge.conf.
#
# Disabled state: touch <module dir>/disabled
# Undo: systemctl stop homebrew-bridge.service
MODULE_DIR=${MODULE_DIR:-/opt/usr/share/selfroot/modules/03-bridge-service}
EVIDENCE=${EVIDENCE:-/home/owner/share/tmp/sdk_tools/selfroot-evidence}
BRIDGE_CONF=/opt/usr/share/selfroot/bridge.conf

if [ ! -f "$MODULE_DIR/TvRootBridgeRelay.dll" ]; then
    echo "TvRootBridgeRelay.dll not staged at $MODULE_DIR — skipping"
    exit 0
fi

if [ ! -f "$BRIDGE_CONF" ]; then
    echo "bridge.conf not found at $BRIDGE_CONF — skipping"
    echo "Generate: python3 -c 'import secrets; print(secrets.token_hex(16))' > $BRIDGE_CONF"
    exit 0
fi

RD=/run/systemd/system
cat > $RD/homebrew-bridge.service <<EOF
[Unit]
Description=Homebrew SDB bridge relay (token-gated)
DefaultDependencies=false
After=network.target
[Service]
Type=simple
ExecStart=/usr/bin/dotnet $MODULE_DIR/TvRootBridgeRelay.dll
Restart=always
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=3
EOF

systemctl daemon-reload 2>/dev/null
systemctl restart homebrew-bridge.service 2>/dev/null
printf 'homebrew-bridge -> %s\n' "$(systemctl is-active homebrew-bridge.service 2>&1)"
exit 0
