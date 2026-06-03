#!/usr/bin/env node
// GitHub PR review notifier.
// Stream 1: PRs needing my review (reads the "Needs my review" query from VS Code settings).
// Stream 2: New review activity (APPROVED / CHANGES_REQUESTED / COMMENTED) on MY PRs ("My PRs" query).
// State is diffed between runs so only *new* items fire a notification.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- config -------------------------------------------------------------
const SETTINGS = join(homedir(), "Library/Application Support/Code/User/settings.json");
const STATE_DIR = join(homedir(), ".local/share/gh-pr-notifier");
const STATE_FILE = join(STATE_DIR, "state.json");
// Resolved via PATH (launchd sets PATH in the plist). Override with env if needed.
const GH = process.env.GH_BIN || "gh";
const NOTIFIER = process.env.NOTIFIER_BIN || "terminal-notifier";

const REVIEW_QUEUE_LABEL = "🔍 Needs my review (no bots)";
const MY_PRS_LABEL = "My PRs";
// Review states on my PRs worth a ping.
const NOTIFY_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]);
// -------------------------------------------------------------------------

const isBot = (login) => !login || /\[bot\]$/i.test(login) || /\bbot\b/i.test(login);

function gh(path, args = []) {
  const out = execFileSync(GH, ["api", ...args, path], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

function search(query) {
  // search/issues handles `is:pr`; returns {items:[...]}
  return gh("search/issues", ["-X", "GET", "-f", "per_page=100", "-f", `q=${query}`]).items || [];
}

function notify({ title, subtitle, message, url, group }) {
  try {
    execFileSync(NOTIFIER, [
      "-title", title,
      "-subtitle", subtitle || "",
      "-message", message,
      "-open", url,
      "-group", group,
    ], { stdio: "ignore" });
  } catch (e) {
    console.error("notify failed:", e.message);
  }
}

// Strip JSONC comments + trailing commas, then parse.
// The query strings contain no `//`, `/*`, or escaped quotes, so a naive strip is safe here.
function readQueries() {
  let raw = readFileSync(SETTINGS, "utf8");
  raw = raw.replace(/\/\*[\s\S]*?\*\//g, "");        // block comments
  raw = raw.replace(/(^|[^:"'])\/\/.*$/gm, "$1");    // line comments (won't touch `://` in URLs)
  raw = raw.replace(/,(\s*[}\]])/g, "$1");           // trailing commas
  const cfg = JSON.parse(raw);
  const q = cfg["githubPullRequests.queries"] || [];
  const byLabel = (label) => (q.find((x) => x.label === label) || {}).query;
  return { reviewQueue: byLabel(REVIEW_QUEUE_LABEL), myPrs: byLabel(MY_PRS_LABEL) };
}

function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return null; }
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
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
        notify({
          title: "🔍 PR needs your review",
          subtitle: repo,
          message: it.title,
          url: it.html_url,
          group: `review-${it.html_url}`,
        });
      }
    }
  }

  // ---- Stream 2: review activity on my PRs ----
  if (myPrs) {
    const q = myPrs.replaceAll("${user}", login);
    const myItems = search(q);
    const prevReviews = prev?.myPrReviews || {};
    for (const it of myItems) {
      const repo = it.repository_url.split("/repos/")[1]; // owner/name
      const num = it.number;
      let reviews = [];
      try { reviews = gh(`repos/${repo}/pulls/${num}/reviews?per_page=100`); }
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
          notify({
            title: `${reviewer} ${verb} your PR`,
            subtitle: `${repo}#${num}`,
            message: it.title,
            url: r.html_url || it.html_url,
            group: `myreview-${id}`,
          });
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
