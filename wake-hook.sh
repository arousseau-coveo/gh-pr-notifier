#!/usr/bin/env bash
# Run by sleepwatcher when the Mac wakes from sleep. Triggers an immediate PR sync.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/poll.mjs"
