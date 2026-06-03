#!/usr/bin/env node
// GitHub PR review notifier.
// Stream 1: PRs needing my review (reads the "Needs my review" query from VS Code settings).
// Stream 2: New review activity (APPROVED / CHANGES_REQUESTED / COMMENTED) on MY PRs ("My PRs" query).
// State is diffed between runs so only *new* items fire a notification.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
const STATE_DIR = pick("STATE_DIR", "stateDir", join(homedir(), ".local/share/gh-pr-notifier"));
const STATE_FILE = join(STATE_DIR, "state.json");
const GH = pick("GH_BIN", "ghBin", "gh");
const OSASCRIPT = "/usr/bin/osascript"; // system binary; no third-party notifier dependency

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
// -------------------------------------------------------------------------

const isBot = (login) => !login || /\[bot\]$/i.test(login) || /\bbot\b/i.test(login);

// "owner/name" with only the chars GitHub actually allows in each segment.
const isValidRepo = (r) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(r);

function gh(path, args = []) {
  const out = execFileSync(GH, ["api", ...args, path], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

function search(query) {
  // search/issues handles `is:pr`; returns {items:[...]}
  return gh("search/issues", ["-X", "GET", "-f", "per_page=100", "-f", `q=${query}`]).items || [];
}

function notify({ title, subtitle, message }) {
  // Native macOS notification via osascript. Untrusted values (PR titles, logins) are passed as
  // AppleScript `argv` items — NOT interpolated into the script source — so a crafted title
  // cannot inject AppleScript. (osascript notifications have no click-to-open; banner only.)
  try {
    execFileSync(OSASCRIPT, [
      "-e", "on run argv",
      "-e", "display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)",
      "-e", "end run",
      "--", message || "", title || "", subtitle || "",
    ], { stdio: "ignore" });
  } catch (e) {
    console.error("notify failed:", e.message);
  }
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
  const state = { reviewQueue: [], myPrReviews: {} };

  // ---- Stream 1: needs my review ----
  if (reviewQueue) {
    const q = reviewQueue.replaceAll("${user}", login);
    const items = search(q);
    const prevSet = new Set(prev?.reviewQueue || []);
    for (const it of items) {
      state.reviewQueue.push(it.html_url);
      if (!firstRun && !prevSet.has(it.html_url)) {
        const repo = it.repository_url.split("/repos/")[1] || "";
        notify({ title: "🔍 PR needs your review", subtitle: repo, message: it.title });
      }
    }
  }

  // ---- Stream 2: review activity on my PRs ----
  if (myPrs) {
    const q = myPrs.replaceAll("${user}", login);
    const myItems = search(q);
    const prevReviews = prev?.myPrReviews || {};
    for (const it of myItems) {
      const repo = (it.repository_url || "").split("/repos/")[1] || ""; // owner/name
      const num = it.number;
      // Validate before interpolating into an API path (prevents `..`/path-traversal redirection).
      if (!isValidRepo(repo) || !Number.isInteger(num) || num <= 0) {
        console.error(`skip invalid repo/num: ${repo}#${num}`);
        continue;
      }
      const [owner, name] = repo.split("/");
      let reviews = [];
      try { reviews = gh(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${num}/reviews?per_page=100`); }
      catch (e) { console.error(`reviews ${repo}#${num}:`, e.message); continue; }
      for (const r of reviews) {
        const id = String(r.id);
        const reviewer = r.user?.login;
        if (!NOTIFY_REVIEW_STATES.has(r.state)) continue;
        if (reviewer === login || isBot(reviewer)) continue;
        state.myPrReviews[id] = true; // remember it (bounded to currently-open PRs)
        if (!firstRun && !prevReviews[id]) {
          const verb = r.state === "CHANGES_REQUESTED" ? "requested changes"
                     : r.state === "APPROVED" ? "approved" : "commented on";
          notify({ title: `${reviewer} ${verb} your PR`, subtitle: `${repo}#${num}`, message: it.title });
        }
      }
    }
  }

  saveState(state);
  console.error(firstRun
    ? "First run: seeded state, no notifications sent."
    : `OK: tracking ${state.reviewQueue.length} review-queue PRs, ${Object.keys(state.myPrReviews).length} my-PR reviews.`);
}

main();
