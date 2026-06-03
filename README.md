# gh-pr-notifier

Native macOS notifications for GitHub review work, driven by a `launchd` poller.

Two notification streams, each diffed between runs so only **new** items fire:

1. **PRs needing my review** — read from a labeled query in VS Code settings (bots excluded by the query itself).
2. **Review activity on my PRs** — `APPROVED` / `CHANGES_REQUESTED` / `COMMENTED` reviews on my own PRs (bot reviewers skipped).

## How it works

`poll.mjs` reads `~/Library/Application Support/Code/User/settings.json`, pulls two queries from
`githubPullRequests.queries` **by label** — so editing the query in VS Code updates the poller with no code change:

- `🔍 Needs my review (no bots)`
- `My PRs`

`${user}` in the queries is resolved via `gh api user`. It then calls the GitHub API through `gh` and
posts notifications with `terminal-notifier`. State lives in `state.json` (gitignored); first run
seeds state silently so there's no backlog spam.

> **Click-to-open is host-locked.** The notification body shows the destination URL, and clicking
> opens it via macOS LaunchServices — but only if the URL passes a hard allowlist (`https` +
> `github.com` host, parsed not regex-matched). A non-GitHub or non-https URL is shown but **not**
> made clickable, so the tool can never open anything but a GitHub PR. `terminal-notifier`'s
> `-execute` (arbitrary shell) is never used.

## When it syncs

- **Every `StartInterval`** (default 300s) — the steady-state poll.
- **At login** — `RunAtLoad` on the main agent fires an immediate sync.
- **On wake from sleep** — handled by `launchd` itself: a `StartInterval` tick that comes due while
  the Mac is asleep runs right after it wakes. No extra agent and **no Input Monitoring permission**.
  (After a sleep shorter than the interval, the next sync is just the normal tick.)

Both agents launch via `run.sh`, which injects the scoped token (below) and then runs `poll.mjs`.

## Requirements

- [`gh`](https://cli.github.com/) — authenticated (`gh auth login`)
- `node` (ESM, no npm deps)
- [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) — `brew install terminal-notifier` (used `-open`-only, never `-execute`)

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

If notifications don't appear, allow them for **terminal-notifier** in System Settings → Notifications.

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

- **Least-privilege token (recommended).** The agent runs every few minutes with whatever
  `gh` token it has. Your default `gh` login is typically broad (`repo`, `workflow` — read/write
  to all repos + CI), which is far more than this read-only tool needs. To shrink the blast
  radius, store a dedicated **fine-grained, read-only PAT** (Pull requests: Read, Metadata: Read)
  and the agent will use only that:

  ```sh
  ./set-token.sh   # paste the PAT (hidden); stored in the login keychain, not in a plist
  ```

  `run.sh` exports it as `GH_TOKEN` for the agents only — your interactive `gh` is untouched.
  If no token is stored, it falls back to your normal `gh` auth (with a warning).
  *Caveat:* orgs that enforce SSO / fine-grained-PAT approval require you to authorize the token
  for that org; if the org blocks PATs entirely, this isolation can't cover its private repos.
- **No language dependencies.** `poll.mjs` uses only Node built-ins — no npm tree to compromise.
- **URL open is host-locked.** Click-to-open passes through a parsed `https` + `github.com`
  allowlist (`safeOpenUrl`), and the URL is shown in the notification body. The tool cannot open
  a non-GitHub or non-https URL. `terminal-notifier`'s `-execute` (arbitrary shell) is never used.
- **Pinned binaries.** `brew pin node gh terminal-notifier` prevents a `brew upgrade` from silently
  swapping in a tampered version (unpin to take security updates). terminal-notifier is
  unmaintained (last release 2017) but distributed via homebrew/core with a checksummed bottle.
- All subprocess calls use argv arrays (no shell); untrusted PR titles/logins can't inject flags
  or shell commands.
- Repo/PR-number values from the API are validated before being placed in an API path.
- `install.sh` pins the **absolute** `gh`/`terminal-notifier` paths into the plist (no `PATH` hijack).
- State/log hold internal repo names + PR titles, so they're created `0600` in a `0700` dir.

> **GitHub search caps results at 100 per query.** For a personal review queue that's never a
> problem, but a very broad query will silently truncate.

## Limitations

- Stream 2 only catches submitted **reviews** (`/pulls/{n}/reviews`), not standalone conversation/inline comments.
- Bot detection is heuristic (`[bot]` suffix or `bot` in the login).
- Notifications only appear while logged into the macOS session.
