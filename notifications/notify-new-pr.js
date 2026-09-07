/**
 * notify-new-pr.js
 *
 * Runs on the `pull_request: opened` event. Posts a single Discord message
 * announcing the new PR. If reviewers were requested at creation time, it
 * @mentions them by their real Discord IDs (via reviewer-map.json). If no
 * reviewers were requested, it falls back to @everyone.
 *
 * Required environment variables:
 *   GITHUB_EVENT_PATH   - set automatically by GitHub Actions, points to
 *                         the JSON file with the full pull_request payload
 *   DISCORD_WEBHOOK_URL - your Discord channel webhook URL
 */

const fs = require("fs");
const path = require("path");

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const eventPath = process.env.GITHUB_EVENT_PATH;

if (!DISCORD_WEBHOOK_URL || !eventPath) {
  console.error("Missing required env vars. Need DISCORD_WEBHOOK_URL and GITHUB_EVENT_PATH.");
  process.exit(1);
}

const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
const pr = event.pull_request;

const reviewerMapPath = path.join(__dirname, "reviewer-map.json");
const rawMap = JSON.parse(fs.readFileSync(reviewerMapPath, "utf8"));
delete rawMap._comment;
const REVIEWER_MAP = rawMap;

function discordMention(githubUsername) {
  const discordId = REVIEWER_MAP[githubUsername];
  return discordId ? `<@${discordId}>` : `**${githubUsername}**`;
}

async function sendDiscordMessage(content) {
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook error ${res.status}: ${await res.text()}`);
  }
}

async function main() {
  const requestedReviewers = pr.requested_reviewers || [];

  const mentions =
    requestedReviewers.length > 0
      ? requestedReviewers.map((u) => discordMention(u.login)).join(" ")
      : "@everyone";

  const message =
    `🆕 **New PR opened** by ${pr.user.login}\n` +
    `**${pr.title}** (#${pr.number})\n` +
    `${pr.html_url}\n` +
    `Review requested: ${mentions}`;

  await sendDiscordMessage(message);
  console.log(`Sent new-PR notification for #${pr.number}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
