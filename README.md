# gh-pr-notifier

Native macOS notifications for GitHub review work, driven by a `launchd` poller.

Two notification streams, each diffed between runs so only **new** items fire:

1. **PRs needing my review** — read from a labeled query in VS Code settings (bots excluded by the query itself).
2. **Review activity on my PRs** — `APPROVED` / `CHANGES_REQUESTED` / `COMMENTED` reviews on my own PRs (bot reviewers skipped).

Clicking a notification opens the PR.

## How it works

`poll.mjs` reads `~/Library/Application Support/Code/User/settings.json`, pulls two queries from
`githubPullRequests.queries` **by label** — so editing the query in VS Code updates the poller with no code change:

- `🔍 Needs my review (no bots)`
- `My PRs`

`${user}` in the queries is resolved via `gh api user`. It then calls the GitHub API through `gh` and
posts notifications with `terminal-notifier`. State lives in `state.json` (gitignored); first run seeds
state silently so there's no backlog spam.

## Requirements

- [`gh`](https://cli.github.com/) — authenticated (`gh auth login`)
- [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) — `brew install terminal-notifier`
- `node` (ESM, no npm deps)

## Install

```sh
git clone https://github.com/arousseau-coveo/gh-pr-notifier.git
cd gh-pr-notifier
./install.sh              # default 5-min interval
INTERVAL=120 ./install.sh # custom interval (seconds)
```

`install.sh` detects binary paths on the current machine, generates the LaunchAgent plist into
`~/Library/LaunchAgents/`, and loads it. The script's own directory is where logs/state are written,
so it runs from wherever you clone it.

Grant the notification permission to `terminal-notifier` the first time (System Settings → Notifications).

## Manage

```sh
PLIST=~/Library/LaunchAgents/com.arousseau.gh-pr-notifier.plist
launchctl unload "$PLIST"   # pause
launchctl load   "$PLIST"   # resume (after editing plist or script)
tail -f poll.log            # watch runs
```

## Customize

- **Add/remove bots:** edit the `🔍 Needs my review (no bots)` query in VS Code — single source of truth.
- **Stop notifying on approvals:** remove `"APPROVED"` from `NOTIFY_REVIEW_STATES` in `poll.mjs`.
- **Different editor settings path:** edit `SETTINGS` in `poll.mjs`.

## Limitations

- Stream 2 only catches submitted **reviews** (`/pulls/{n}/reviews`), not standalone conversation/inline comments.
- Bot detection is heuristic (`[bot]` suffix or `bot` in the login).
- Notifications only appear while logged into the macOS session.
