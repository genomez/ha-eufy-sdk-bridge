#!/bin/sh
# Modified for genomez S1 experimental source preview, 2026-10-14.
set -e
umask 077
export AUTH_RECOVERY_HOLD=/data/auth-recovery-hold.json
exec node "${BRIDGE_APP_DIR:-/app}/bin/pilot-process.mjs"
