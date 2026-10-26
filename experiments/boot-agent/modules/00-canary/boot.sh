#!/bin/sh
# homebrew module: 00-canary
# Proves the boot-time module runner executes as root. No side effects.
echo "canary-ran uid=$(id -u) gid=$(id -g) at $(date)"
uname -a
cat /proc/self/attr/current 2>/dev/null || true
exit 0
