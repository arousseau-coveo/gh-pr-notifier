#!/usr/bin/env bash
# Installs the gh-pr-notifier LaunchAgent for the current user/machine.
# Generates the plist with paths detected on THIS machine, then loads it.
set -euo pipefail

LABEL="com.arousseau.gh-pr-notifier"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLL="$SCRIPT_DIR/poll.mjs"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
INTERVAL="${INTERVAL:-300}"   # override: INTERVAL=120 ./install.sh

# --- dependency check ---
missing=0
for bin in node gh terminal-notifier; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "MISSING: $bin"; missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "Install missing deps first (e.g. 'brew install terminal-notifier gh node') and re-run." >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
# PATH for launchd: the dirs holding our tools + system defaults.
BIN_DIRS="$(dirname "$NODE_BIN"):$(dirname "$(command -v gh)"):$(dirname "$(command -v terminal-notifier)")"
LAUNCHD_PATH="$(echo "$BIN_DIRS" | tr ':' '\n' | sort -u | paste -sd: -):/usr/bin:/bin:/usr/sbin:/sbin"

if ! gh auth status >/dev/null 2>&1; then
  echo "WARN: 'gh' is not authenticated. Run 'gh auth login' or notifications will fail." >&2
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$POLL</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$LAUNCHD_PATH</string>
    </dict>
    <key>StartInterval</key>
    <integer>$INTERVAL</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$SCRIPT_DIR/poll.log</string>
    <key>StandardErrorPath</key>
    <string>$SCRIPT_DIR/poll.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Installed and loaded $LABEL (interval ${INTERVAL}s)."
echo "Plist: $PLIST"
echo "Logs:  $SCRIPT_DIR/poll.log"
echo "Uninstall: launchctl unload \"$PLIST\" && rm \"$PLIST\""
