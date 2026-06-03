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

## When it syncs

- **Every `StartInterval`** (default 300s) — the steady-state poll.
- **At login** — `RunAtLoad` on the main agent fires an immediate sync.
- **On wake from sleep** — a second LaunchAgent runs `sleepwatcher`, which triggers `wake-hook.sh`
  (an immediate sync) the moment the Mac wakes. Optional; skipped if `sleepwatcher` isn't installed.

## Requirements

- [`gh`](https://cli.github.com/) — authenticated (`gh auth login`)
- [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) — `brew install terminal-notifier`
- `node` (ESM, no npm deps)
- [`sleepwatcher`](https://www.bernhard-baehr.de/) (optional) — `brew install sleepwatcher`, for instant sync on wake

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

## Configure

No code edits needed. Precedence for every setting is **env var > config file > built-in default**.

Config file: `$GH_PR_NOTIFIER_CONFIG`, else `~/.config/gh-pr-notifier/config.json`. Copy
`config.example.json` and keep only the keys you want to override.

| Setting | Env var | Config key | Default |
|---|---|---|---|
| Review-queue query label | `REVIEW_QUEUE_LABEL` | `reviewQueueLabel` | `🔍 Needs my review (no bots)` |
| My-PRs query label | `MY_PRS_LABEL` | `myPrsLabel` | `My PRs` |
| Review-queue query (direct, skips editor lookup) | `REVIEW_QUEUE_QUERY` | `reviewQueueQuery` | — |
| My-PRs query (direct) | `MY_PRS_QUERY` | `myPrsQuery` | — |
| Review states to notify on | `NOTIFY_REVIEW_STATES` | `notifyReviewStates` | `APPROVED,CHANGES_REQUESTED,COMMENTED` |
| Editor settings.json path | `EDITOR_SETTINGS` | `editorSettingsPath` | VS Code path |
| State dir | `STATE_DIR` | `stateDir` | `~/.local/share/gh-pr-notifier` |
| `gh` binary | `GH_BIN` | `ghBin` | from `PATH` |
| `terminal-notifier` binary | `NOTIFIER_BIN` | `notifierBin` | from `PATH` |

- **No VS Code?** Set `reviewQueueQuery` / `myPrsQuery` directly and `settings.json` is never read.
- **Add/remove bots / stop notifying on approvals:** edit the query / `notifyReviewStates`.

## Security notes

- All subprocess calls use argv arrays (no shell); untrusted PR titles/logins can't inject flags
  or shell commands. `terminal-notifier`'s `-execute` is never used, and `-open` only ever
  receives an `https://` URL.
- Repo/PR-number values from the API are validated before being placed in an API path.
- `install.sh` pins **absolute** `gh`/`terminal-notifier` paths into the plist (no `PATH` hijack).
- State/log hold internal repo names + PR titles, so they're created `0600` in a `0700` dir.

> **GitHub search caps results at 100 per query.** For a personal review queue that's never a
> problem, but a very broad query will silently truncate.

## Limitations

- Stream 2 only catches submitted **reviews** (`/pulls/{n}/reviews`), not standalone conversation/inline comments.
- Bot detection is heuristic (`[bot]` suffix or `bot` in the login).
- Notifications only appear while logged into the macOS session.
