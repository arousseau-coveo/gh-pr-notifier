#!/usr/bin/env node
// GitHub PR review notifier.
// Stream 1: PRs needing my review (reads the "Needs my review" query from VS Code settings).
// Stream 2: New review activity (APPROVED / CHANGES_REQUESTED / COMMENTED) on MY PRs ("My PRs" query).
// State is diffed between runs so only *new* items fire a notification.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // dir this script lives in (for bundled assets)

// ---- config -------------------------------------------------------------
// Precedence for every setting: environment variable > config file > built-in default.
// Config file: $GH_PR_NOTIFIER_CONFIG, else ~/.config/gh-pr-notifier/config.json (JSON).
// See config.example.json for all keys.
const CONFIG_PATH = process.env.GH_PR_NOTIFIER_CONFIG
  || join(homedir(), ".config/gh-pr-notifier/config.json");

function loadConfigFile() {
  if (!existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")); }
  catch (e) { console.error(`Ignoring invalid config ${CONFIG_PATH}: ${e.message}`); return {}; }
}
const FILE = loadConfigFile();
const env = (k) => { const v = process.env[k]; return v === undefined || v === "" ? undefined : v; };
const pick = (envKey, fileKey, dflt) => env(envKey) ?? FILE[fileKey] ?? dflt;

const SETTINGS = pick("EDITOR_SETTINGS", "editorSettingsPath",
  join(homedir(), "Library/Application Support/Code/User/settings.json"));
const STATE_DIR = pick("STATE_DIR", "stateDir", HERE); // defaults next to the script (gitignored)
const STATE_FILE = join(STATE_DIR, "state.json");
const GH = pick("GH_BIN", "ghBin", "gh");
const NOTIFIER = pick("NOTIFIER_BIN", "notifierBin", "terminal-notifier");
// Notification icon (terminal-notifier -appIcon). Defaults to the bundled icon.png; set to "" to
// disable, or point at any image. Edit icon.svg + re-run rsvg-convert to change the bundled one.
const ICON = pick("ICON_PATH", "iconPath", join(HERE, "icon.png"));

const REVIEW_QUEUE_LABEL = pick("REVIEW_QUEUE_LABEL", "reviewQueueLabel", "🔍 Needs my review (no bots)");
const MY_PRS_LABEL = pick("MY_PRS_LABEL", "myPrsLabel", "My PRs");
// Optional: supply the search query directly and skip the editor-settings lookup entirely
// (lets the tool run with no VS Code / no settings.json at all).
const REVIEW_QUEUE_QUERY = pick("REVIEW_QUEUE_QUERY", "reviewQueueQuery", null);
const MY_PRS_QUERY = pick("MY_PRS_QUERY", "myPrsQuery", null);

// Review states on my PRs worth a ping. Env = comma-separated; file = array or string.
const parseStates = (v) => (Array.isArray(v) ? v : String(v).split(","))
  .map((s) => s.trim().toUpperCase()).filter(Boolean);
const NOTIFY_REVIEW_STATES = new Set(parseStates(
  env("NOTIFY_REVIEW_STATES") ?? FILE.notifyReviewStates ?? "APPROVED,CHANGES_REQUESTED,COMMENTED"));

// Also notify on conversation comments + inline-thread replies on my PRs (not just submitted reviews).
const truthy = (v, dflt) => (v === undefined ? dflt : !(v === false || v === "false" || v === "0" || v === ""));
const NOTIFY_COMMENTS = truthy(env("NOTIFY_COMMENTS") ?? FILE.notifyComments, true);

// Extra bot authors to silence (machine-user bots that don't carry GitHub's Bot type or a "bot"
// name, e.g. renovate-coveo, stepsecurity-app). Case-insensitive substring match. Comma-sep / array.
const parseList = (v) => (Array.isArray(v) ? v : String(v).split(",")).map((s) => s.trim().toLowerCase()).filter(Boolean);
const IGNORE_AUTHORS = parseList(env("IGNORE_AUTHORS") ?? FILE.ignoreAuthors ?? "");
// -------------------------------------------------------------------------

// Decide if a comment/review author is a bot. Takes the API `user` object so we can read its
// `type` ("Bot" for GitHub Apps). Also catches "[bot]" suffix, names ending in "bot" (coveobot),
// "bot" as a word, and the configurable IGNORE_AUTHORS denylist.
function isBotUser(u) {
  const login = (u?.login || "").toLowerCase();
  if (!login) return true;
  if (u?.type === "Bot") return true;
  if (/\[bot\]$/.test(login) || /bot$/.test(login) || /\bbot\b/.test(login)) return true;
  return IGNORE_AUTHORS.some((p) => login.includes(p));
}
const clip = (s, n = 140) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);

// "owner/name" with only the chars GitHub actually allows in each segment.
const isValidRepo = (r) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(r);

// Hard allowlist for what we'll let the OS open: parsed (not regex-matched) and locked to
// https + github.com host, so spoofs like github.com.evil.com or github.com@evil.com are rejected.
function safeOpenUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && (x.hostname === "github.com" || x.hostname === "www.github.com")
      ? x.href : null;
  } catch { return null; }
}

function gh(path, args = []) {
  const out = execFileSync(GH, ["api", ...args, path], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

function search(query) {
  // search/issues handles `is:pr`; returns {items:[...]}
  return gh("search/issues", ["-X", "GET", "-f", "per_page=100", "-f", `q=${query}`]).items || [];
}

function notify({ title, subtitle, message, url, group }) {
  // Args are passed as an array (no shell); untrusted values can't inject flags. The URL is shown
  // in the body so you see the destination before clicking, and -open only ever receives a URL
  // that passed the github.com allowlist. `-execute` (arbitrary shell) is never used.
  const open = safeOpenUrl(url);
  const body = open ? `${message}\n${open}` : message;
  const args = ["-title", title, "-subtitle", subtitle || "", "-message", body];
  if (ICON && existsSync(ICON)) args.push("-appIcon", ICON);
  if (group) args.push("-group", group);
  if (open) args.push("-open", open);
  try { execFileSync(NOTIFIER, args, { stdio: "ignore" }); }
  catch (e) { console.error("notify failed:", e.message); }
}

// Resolve the two search queries. A directly-configured query wins; otherwise look it up by
// label in the editor's settings.json. The settings file is only read if at least one query
// still needs it, so the tool works fine with no editor installed.
function readQueries() {
  let byLabel = () => undefined;
  if (!REVIEW_QUEUE_QUERY || !MY_PRS_QUERY) {
    try {
      // Strip JSONC comments + trailing commas, then parse.
      let raw = readFileSync(SETTINGS, "utf8");
      raw = raw.replace(/\/\*[\s\S]*?\*\//g, "");        // block comments
      raw = raw.replace(/(^|[^:"'])\/\/.*$/gm, "$1");    // line comments (won't touch `://`)
      raw = raw.replace(/,(\s*[}\]])/g, "$1");           // trailing commas
      const cfg = JSON.parse(raw);
      const q = cfg["githubPullRequests.queries"] || [];
      byLabel = (label) => (q.find((x) => x.label === label) || {}).query;
    } catch (e) {
      console.error(`Could not read editor settings ${SETTINGS}: ${e.message}`);
    }
  }
  return {
    reviewQueue: REVIEW_QUEUE_QUERY || byLabel(REVIEW_QUEUE_LABEL),
    myPrs: MY_PRS_QUERY || byLabel(MY_PRS_LABEL),
  };
}

function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return null; }
}

function saveState(state) {
  // Restrict to the owner: state/log expose internal repo names and PR titles.
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { chmodSync(STATE_FILE, 0o600); } catch { /* best effort if pre-existing */ }
}

// -------------------------------------------------------------------------
function main() {
  const login = gh("user").login;
  const { reviewQueue, myPrs } = readQueries();
  if (!reviewQueue) console.error(`Query "${REVIEW_QUEUE_LABEL}" not found in settings.json`);

  const prev = loadState();
  const firstRun = prev === null;
  const state = { reviewQueue: [], myPrReviews: {}, myPrComments: {} };

  // ---- Stream 1: needs my review ----
  if (reviewQueue) {
    const q = reviewQueue.replaceAll("${user}", login);
    const items = search(q);
    const prevSet = new Set(prev?.reviewQueue || []);
    for (const it of items) {
      state.reviewQueue.push(it.html_url);
      if (!firstRun && !prevSet.has(it.html_url)) {
        const repo = it.repository_url.split("/repos/")[1] || "";
        notify({ title: "🔍 PR needs your review", subtitle: repo, message: it.title, url: it.html_url, group: `review-${it.html_url}` });
      }
    }
  }

  // ---- Stream 2: review activity on my PRs ----
  if (myPrs) {
    const q = myPrs.replaceAll("${user}", login);
    const myItems = search(q);
    const prevReviews = prev?.myPrReviews || {};
    const prevComments = prev?.myPrComments || {};
    for (const it of myItems) {
      const repo = (it.repository_url || "").split("/repos/")[1] || ""; // owner/name
      const num = it.number;
      // Validate before interpolating into an API path (prevents `..`/path-traversal redirection).
      if (!isValidRepo(repo) || !Number.isInteger(num) || num <= 0) {
        console.error(`skip invalid repo/num: ${repo}#${num}`);
        continue;
      }
      const [owner, name] = repo.split("/");
      const api = (p) => gh(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${p}?per_page=100`);

      // Submitted reviews (approve / request-changes / summary comment).
      let reviews = [];
      try { reviews = api(`pulls/${num}/reviews`); }
      catch (e) { console.error(`reviews ${repo}#${num}:`, e.message); }
      for (const r of reviews) {
        const id = String(r.id);
        const reviewer = r.user?.login;
        if (!NOTIFY_REVIEW_STATES.has(r.state)) continue;
        if (reviewer === login || isBotUser(r.user)) continue;
        // An empty-bodied COMMENTED review is just a wrapper around inline comments/replies, which
        // the comment streams below report with their actual content — skip to avoid double-notify.
        if (r.state === "COMMENTED" && !clip(r.body)) continue;
        state.myPrReviews[id] = true; // remember it (bounded to currently-open PRs)
        if (!firstRun && !prevReviews[id]) {
          const verb = r.state === "CHANGES_REQUESTED" ? "requested changes on"
                     : r.state === "APPROVED" ? "approved" : "commented on";
          notify({ title: `${reviewer} ${verb} your PR`, subtitle: `${repo}#${num}`, message: clip(r.body) || it.title, url: r.html_url || it.html_url, group: `myreview-${id}` });
        }
      }

      // Conversation comments + inline-thread replies (the gap that submitted reviews miss).
      if (NOTIFY_COMMENTS) {
        for (const src of [
          { path: `pulls/${num}/comments`, kp: "rc" },   // inline diff comments + replies
          { path: `issues/${num}/comments`, kp: "ic" },  // conversation timeline
        ]) {
          let comments = [];
          try { comments = api(src.path); }
          catch (e) { console.error(`${src.path} ${repo}#${num}:`, e.message); continue; }
          for (const c of comments) {
            const key = `${src.kp}:${c.id}`;
            const author = c.user?.login;
            if (author === login || isBotUser(c.user)) continue;
            state.myPrComments[key] = true;
            if (!firstRun && !prevComments[key]) {
              const verb = c.in_reply_to_id ? "replied on" : "commented on";
              notify({ title: `${author} ${verb} your PR`, subtitle: `${repo}#${num}`, message: clip(c.body) || it.title, url: c.html_url || it.html_url, group: `mycomment-${key}` });
            }
          }
        }
      }
    }
  }

  saveState(state);
  console.error(firstRun
    ? "First run: seeded state, no notifications sent."
    : `OK: tracking ${state.reviewQueue.length} review-queue PRs, ${Object.keys(state.myPrReviews).length} my-PR reviews, ${Object.keys(state.myPrComments).length} comments.`);
}

main();
