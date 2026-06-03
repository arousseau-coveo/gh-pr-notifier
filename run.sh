#!/usr/bin/env bash
# Single entrypoint for the LaunchAgent.
# Two supported auth modes:
#   1. Default: use your normal `gh` login (the GitHub CLI OAuth token). Fine for this read-only
#      tool. This is the expected mode where orgs disable fine-grained PATs (e.g. coveo-platform).
#   2. Optional hardening: if a dedicated read-only token is stored in the login keychain (item
#      'gh-pr-notifier', via ./set-token.sh), export it as GH_TOKEN so the agent uses ONLY that
#      token (gh prefers GH_TOKEN over its keychain auth), without touching your interactive `gh`.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TOKEN="$(security find-generic-password -s gh-pr-notifier -w 2>/dev/null || true)"
[ -n "$TOKEN" ] && export GH_TOKEN="$TOKEN"   # else fall back silently to gh's normal auth

exec node "$SCRIPT_DIR/poll.mjs"
