#!/bin/sh
# homebrew module: 02-ssh-service
# Launches tizen-ssh as a supervised systemd service at every boot.
#
# Requires tizen-ssh to be staged at /opt/usr/share/selfroot/ssh/.
# The SSH server runs under the TV's bundled dotnet with the caps from
# the archive-root route (cap_sys_admin), giving a real root shell.
#
# UEP note: the systemd unit runs /usr/bin/dotnet directly (signed binary,
# caps in ELF headers). The TizenSsh.dll is managed IL — UEP does not
# check it.
#
# Disabled state: touch <module dir>/disabled
# Undo: systemctl stop homebrew-ssh.service
MODULE_DIR=${MODULE_DIR:-/opt/usr/share/selfroot/modules/02-ssh-service}
EVIDENCE=${EVIDENCE:-/home/owner/share/tmp/sdk_tools/selfroot-evidence}
SSH_DIR=/opt/usr/share/selfroot/ssh

if [ ! -f "$SSH_DIR/TizenSsh.dll" ]; then
    echo "tizen-ssh not staged at $SSH_DIR — skipping"
    echo "Stage it: cp tizen-ssh/* $SSH_DIR/"
    exit 0
fi

# Ensure config and host key directory are writable.
chmod -R 755 "$SSH_DIR" 2>/dev/null
chsmack -r -a _ "$SSH_DIR" 2>/dev/null

RD=/run/systemd/system
cat > $RD/homebrew-ssh.service <<EOF
[Unit]
Description=tizen-ssh (homebrew SSH server)
DefaultDependencies=false
After=network.target
[Service]
Type=simple
WorkingDirectory=$SSH_DIR
ExecStart=/usr/bin/dotnet $SSH_DIR/TizenSsh.dll
Restart=always
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5
EOF

systemctl daemon-reload 2>/dev/null
systemctl restart homebrew-ssh.service 2>/dev/null
printf 'homebrew-ssh -> %s\n' "$(systemctl is-active homebrew-ssh.service 2>&1)"
exit 0
