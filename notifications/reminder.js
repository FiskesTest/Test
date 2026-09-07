/**
 * pr-reminder.js
 *
 * Checks all open PRs in a repo, finds reviewers who still haven't submitted
 * a review, and pings them on Discord (real @mentions). Authors are never
 * pinged for their own PR, and anyone who has already reviewed (approved,
 * requested changes, or commented as a review) is skipped automatically,
 * because GitHub removes completed reviewers from the "requested reviewers"
 * list once they submit a review.
 *
 * Required environment variables:
 *   GITHUB_TOKEN   - a token with repo read access (the default
 *                    secrets.GITHUB_TOKEN in Actions works fine)
 *   GITHUB_REPOSITORY - "owner/repo" (Actions sets this automatically)
 *   DISCORD_WEBHOOK_URL - your Discord channel webhook URL
 *
 * Reviewer mapping:
 *   reviewer-map.json in the same folder maps GitHub usernames -> Discord
 *   user IDs, so we can send a real <@id> mention.
 */

const fs = require("fs");
const path = require("path");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY; // "owner/repo"
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Must match the cron schedule in .github/workflows/pr-reminder.yml.
// Used to detect whether a PR has just crossed one of the reminder
// thresholds below since it was created.
const RUN_INTERVAL_MINUTES = 30;

// Reminder fires once at each of these marks (hours since PR creation).
// Not repeating — just these two checkpoints.
const REMINDER_THRESHOLDS_HOURS = [2, 24];

if (!GITHUB_TOKEN || !REPO || !WEBHOOK_URL) {
  console.error(
    "Missing required env vars. Need GITHUB_TOKEN, GITHUB_REPOSITORY, DISCORD_WEBHOOK_URL."
  );
  process.exit(1);
}

const [OWNER, REPO_NAME] = REPO.split("/");
const reviewerMapPath = path.join(__dirname, "reviewer-map.json");
const rawMap = JSON.parse(fs.readFileSync(reviewerMapPath, "utf8"));
delete rawMap._comment;
const REVIEWER_MAP = rawMap;

async function githubApi(endpoint) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status} for ${endpoint}: ${await res.text()}`);
  }
  return res.json();
}

async function getOpenPRs() {
  return githubApi(`/repos/${OWNER}/${REPO_NAME}/pulls?state=open&per_page=100`);
}

async function getRequestedReviewers(prNumber) {
  // Returns { users: [...], teams: [...] } — people who have NOT yet reviewed.
  return githubApi(
    `/repos/${OWNER}/${REPO_NAME}/pulls/${prNumber}/requested_reviewers`
  );
}

function discordMention(githubUsername) {
  const discordId = REVIEWER_MAP[githubUsername];
  return discordId ? `<@${discordId}>` : `**${githubUsername}**`;
}

async function sendDiscordMessage(content) {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook error ${res.status}: ${await res.text()}`);
  }
}

async function main() {
  const prs = await getOpenPRs();

  if (prs.length === 0) {
    console.log("No open PRs. Nothing to remind.");
    return;
  }

  const now = new Date();

  for (const pr of prs) {
    // Skip draft PRs — they're not ready for review yet.
    if (pr.draft) continue;

    const createdAt = new Date(pr.created_at);
    const elapsedHours = (now - createdAt) / 3600000;
    const previousElapsedHours = elapsedHours - RUN_INTERVAL_MINUTES / 60;

    // Find a threshold (2h, 24h, ...) that we've just crossed since the
    // last run — i.e. previousElapsedHours was below it and elapsedHours
    // is now at or above it. Each threshold only ever fires once per PR.
    const crossedThreshold = REMINDER_THRESHOLDS_HOURS.find(
      (threshold) => previousElapsedHours < threshold && elapsedHours >= threshold
    );

    if (!crossedThreshold) continue;

    const { users } = await getRequestedReviewers(pr.number);

    if (!users || users.length === 0) {
      // Either no reviewers requested, or everyone already reviewed.
      continue;
    }

    const mentions = users.map((u) => discordMention(u.login)).join(" ");

    const message =
      `⏰ **Review reminder** — PR still waiting on review (${crossedThreshold}h+):\n` +
      `**${pr.title}** (#${pr.number}) by ${pr.user.login}\n` +
      `${pr.html_url}\n` +
      `Pending: ${mentions}`;

    await sendDiscordMessage(message);
    console.log(`Sent ${crossedThreshold}h reminder for PR #${pr.number} to: ${users.map((u) => u.login).join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});