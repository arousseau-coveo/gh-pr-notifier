#!/usr/bin/env bash
# Store a dedicated read-only GitHub token for the notifier in the login keychain (encrypted at
# rest). The token is read from stdin so it never lands in your shell history or argv.
#
# First create a FINE-GRAINED PAT at https://github.com/settings/personal-access-tokens/new with:
#   - Resource owner: the org(s) you review in (e.g. coveo-platform) or your account
#   - Repository access: the repos you review (or "All repositories" you can read)
#   - Permissions (read-only): Pull requests: Read, Metadata: Read  (Contents: Read optional)
# If the org enforces SSO / fine-grained PAT approval, authorize the token for that org afterwards.
set -euo pipefail

printf "Paste the fine-grained PAT (input hidden), then press Enter: " >&2
read -rs TOKEN
echo >&2
[ -n "$TOKEN" ] || { echo "No token entered; aborting." >&2; exit 1; }

# -U update if present, -A allow access without per-read prompt (token is already low-privilege).
security add-generic-password -U -A -a "$USER" -s "gh-pr-notifier" -w "$TOKEN"
echo "Stored. Verifying it can authenticate..." >&2
if GH_TOKEN="$TOKEN" gh api user --jq '.login' >/dev/null 2>&1; then
  echo "OK: token works (login: $(GH_TOKEN="$TOKEN" gh api user --jq '.login'))." >&2
else
  echo "WARN: token stored but 'gh api user' failed. Check the PAT scopes / SSO authorization." >&2
fi
echo "To remove later: security delete-generic-password -s gh-pr-notifier" >&2
