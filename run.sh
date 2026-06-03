#!/usr/bin/env bash
# Single entrypoint for both LaunchAgents (interval + wake).
# If a dedicated read-only token is stored in the login keychain, export it as GH_TOKEN so the
# agent uses ONLY that token (gh prefers GH_TOKEN over its keychain auth). This isolates the
# notifier to least privilege without touching your interactive `gh` login. If no token is
# stored, it falls back to gh's normal auth.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TOKEN="$(security find-generic-password -s gh-pr-notifier -w 2>/dev/null || true)"
if [ -n "$TOKEN" ]; then
  export GH_TOKEN="$TOKEN"
else
  echo "WARN: no 'gh-pr-notifier' keychain token found; using your full gh auth (broad scope). Run ./set-token.sh." >&2
fi

exec node "$SCRIPT_DIR/poll.mjs"
