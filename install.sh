#!/usr/bin/env bash
# Installs the gh-pr-notifier LaunchAgent for the current user/machine.
# Generates the plist with paths detected on THIS machine, then loads it.
set -euo pipefail

LABEL="com.arousseau.gh-pr-notifier"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$SCRIPT_DIR/run.sh"   # entrypoint: injects scoped GH_TOKEN, then runs poll.mjs
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
INTERVAL="${INTERVAL:-300}"   # override: INTERVAL=120 ./install.sh
chmod +x "$SCRIPT_DIR/run.sh" "$SCRIPT_DIR/set-token.sh" "$SCRIPT_DIR/poll.mjs" 2>/dev/null || true

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
GH_BIN="$(command -v gh)"
NOTIFIER_BIN="$(command -v terminal-notifier)"
BIN_DIRS="$(dirname "$NODE_BIN"):$(dirname "$GH_BIN"):$(dirname "$NOTIFIER_BIN")"
LAUNCHD_PATH="$(echo "$BIN_DIRS" | tr ':' '\n' | sort -u | paste -sd: -):/usr/bin:/bin:/usr/sbin:/sbin"

if ! gh auth status >/dev/null 2>&1; then
  echo "WARN: 'gh' is not authenticated. Run 'gh auth login' or notifications will fail." >&2
fi

mkdir -p "$HOME/Library/LaunchAgents"
# State/log can contain internal repo names + PR titles: keep them owner-only.
mkdir -p "$SCRIPT_DIR" && chmod 700 "$SCRIPT_DIR"
: > "$SCRIPT_DIR/poll.log" 2>/dev/null || true
chmod 600 "$SCRIPT_DIR/poll.log" 2>/dev/null || true
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$RUN</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$LAUNCHD_PATH</string>
        <key>GH_BIN</key>
        <string>$GH_BIN</string>
        <key>NOTIFIER_BIN</key>
        <string>$NOTIFIER_BIN</string>
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
echo "Installed and loaded $LABEL (interval ${INTERVAL}s, also runs at login via RunAtLoad)."
echo "Plist: $PLIST"
echo "Logs:  $SCRIPT_DIR/poll.log"

# --- wake-from-sleep trigger (optional, needs sleepwatcher) ---
WAKE_LABEL="$LABEL.wake"
WAKE_PLIST="$HOME/Library/LaunchAgents/$WAKE_LABEL.plist"
SLEEPWATCHER=""
for p in "$(command -v sleepwatcher 2>/dev/null || true)" /opt/homebrew/sbin/sleepwatcher /usr/local/sbin/sleepwatcher; do
  [ -n "$p" ] && [ -x "$p" ] && SLEEPWATCHER="$p" && break
done

if [ -n "$SLEEPWATCHER" ]; then
  cat > "$WAKE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$WAKE_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$SLEEPWATCHER</string>
        <string>-w</string>
        <string>$RUN</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$LAUNCHD_PATH</string>
        <key>GH_BIN</key>
        <string>$GH_BIN</string>
        <key>NOTIFIER_BIN</key>
        <string>$NOTIFIER_BIN</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$SCRIPT_DIR/poll.log</string>
    <key>StandardErrorPath</key>
    <string>$SCRIPT_DIR/poll.log</string>
</dict>
</plist>
EOF
  launchctl unload "$WAKE_PLIST" 2>/dev/null || true
  launchctl load "$WAKE_PLIST"
  echo "Installed and loaded $WAKE_LABEL (sleepwatcher -> run.sh on wake)."
else
  echo "NOTE: sleepwatcher not found; wake-from-sleep trigger skipped."
  echo "      Install it with 'brew install sleepwatcher' and re-run for instant sync on wake."
fi

echo "Uninstall: launchctl unload \"$PLIST\" \"$WAKE_PLIST\" 2>/dev/null; rm -f \"$PLIST\" \"$WAKE_PLIST\""
