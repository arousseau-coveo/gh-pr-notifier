# Security Policy

## Scope

`gh-pr-notifier` is a personal macOS tool that polls GitHub and posts local notifications. It runs
on your machine under your own user account and uses your `gh` credentials (or an optional
read-only token in your login keychain). It has no server component and no network listener.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
(the **Security** tab → *Report a vulnerability*), or contact the maintainer directly.

Please include: affected file/command, macOS version, and reproduction steps.

## Design notes relevant to security

- **No third-party language dependencies** — `poll.mjs` uses only Node built-ins; there is no npm
  dependency tree to compromise. The only external programs are `gh`, `terminal-notifier`, and
  `node` (all from Homebrew core, pinned).
- **No shell injection** — every subprocess call uses an argv array (no shell); untrusted PR
  titles, comment bodies, and logins are passed as arguments, never interpolated into a command.
- **URL open is host-locked** — click-to-open only ever hands an `https://github.com/…` URL to
  macOS LaunchServices (parsed, not regex-matched); `terminal-notifier -execute` is never used.
- **API-path inputs validated** — repo names and PR numbers from the API are checked before being
  placed in a request path.
- **Least privilege (optional)** — a read-only fine-grained PAT can be stored in the login keychain
  (`./set-token.sh`) so the agent doesn't use your broad `gh` login. See the README.
- **Local data** — `state.json` / `poll.log` may contain repo names and PR titles; they are created
  `0600` in a `0700` directory.
