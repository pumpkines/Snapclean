// Builds test/fixtures/snapchat_my_data_test.zip — a synthetic Snapchat "My
// Data" HTML export covering the scenarios required by the SnapClean spec's
// TESTING section. Dates are computed relative to "now" so the inactivity
// buckets (6mo/1y/2y) stay correct no matter when the test runs.

import { zipSync, strToU8 } from "fflate";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DAY = 86400000;
const now = Date.now();
const daysAgo = (n) => new Date(now - n * DAY).toISOString().slice(0, 19).replace("T", " ") + " UTC";

function friendRow(username, dateStr, source) {
  return `<tr><td>${username}</td><td>${dateStr || ""}</td><td>${source || ""}</td></tr>`;
}

const friendsHtml = `<!doctype html><html><body>
<h2>Friends (9)</h2>
<table>
<tr><th>Username</th><th>Date Added</th><th>Reason Added</th></tr>
${friendRow("alice_current", daysAgo(1100), "ADDED_BY_USERNAME")}
${friendRow("erin_inactive6mo", daysAgo(900), "ADDED_BY_USERNAME")}
${friendRow("frank_inactive1y", daysAgo(1000), "ADDED_BY_USERNAME")}
${friendRow("grace_inactive2y", daysAgo(1500), "ADDED_BY_USERNAME")}
${friendRow("henry_nohist", daysAgo(500), "ADDED_BY_USERNAME")}
${friendRow("ivy_otherlast", daysAgo(600), "ADDED_BY_USERNAME")}
${friendRow("jack_dup", daysAgo(200), "ADDED_BY_USERNAME")}
${friendRow("leo_nochat_hassnap", daysAgo(700), "ADDED_BY_USERNAME")}
${friendRow("mia_nosnap_haschat", daysAgo(650), "ADDED_BY_USERNAME")}
</table>

<h2>Deleted Friends (2)</h2>
<table>
<tr><th>Username</th><th>Date Deleted</th><th>Reason</th></tr>
${friendRow("bob_former", daysAgo(400), "")}
${friendRow("jack_dup", daysAgo(900), "")}
</table>

<h2>Friend Requests Sent (2)</h2>
<table>
<tr><th>Username</th><th>Date</th><th>Reason</th></tr>
${friendRow("carol_sentonly", daysAgo(400), "")}
${friendRow("karen_nodates", "", "")}
</table>

<h2>Pending Friend Requests (1)</h2>
<table>
<tr><th>Username</th><th>Date</th><th>Reason</th></tr>
${friendRow("dave_pending", daysAgo(10), "")}
</table>
</body></html>`;

const accountHtml = `<!doctype html><html><body>
<table><tr><td>Username</td><td>self_owner</td></tr></table>
</body></html>`;

function historyIndexButton(prefix, username, path) {
  return `<button class="single_chat" onclick="window.location.href='${path}'">${prefix}${username}</button>`;
}

const chatSubjects = [
  ["alice_current", "html/chat_history/alice_current_chat_history.html"],
  ["ivy_otherlast", "html/chat_history/ivy_otherlast_chat_history.html"],
  ["jack_dup", "html/chat_history/jack_dup_chat_history.html"],
  ["mia_nosnap_haschat", "html/chat_history/mia_nosnap_haschat_chat_history.html"],
  ["erin_inactive6mo", "html/chat_history/erin_inactive6mo_chat_history.html"],
  ["frank_inactive1y", "html/chat_history/frank_inactive1y_chat_history.html"],
  ["grace_inactive2y", "html/chat_history/grace_inactive2y_chat_history.html"],
];

const snapSubjects = [
  ["alice_current", "html/snap_history/alice_current_snap_history.html"],
  ["leo_nochat_hassnap", "html/snap_history/leo_nochat_hassnap_snap_history.html"],
];

const chatHistoryHtml = `<!doctype html><html><body>
${chatSubjects.map(([u, p]) => historyIndexButton("Chat History with ", u, p.replace("html/", ""))).join("\n")}
</body></html>`;

const snapHistoryHtml = `<!doctype html><html><body>
${snapSubjects.map(([u, p]) => historyIndexButton("Snap History with ", u, p.replace("html/", ""))).join("\n")}
</body></html>`;

function chatRow(dateStr, from, type = "TEXT") {
  return `<tr><td>${dateStr}</td><td>From: ${from}</td><td>Media Type: ${type}</td></tr>`;
}

const subpages = {};

// alice_current: recent activity, SELF sent last.
subpages["html/chat_history/alice_current_chat_history.html"] = `<table>
${chatRow(daysAgo(20), "self_owner")}
${chatRow(daysAgo(5), "self_owner")}
${chatRow(daysAgo(3), "alice_current", "STATUS")}
</table>`;
subpages["html/snap_history/alice_current_snap_history.html"] = `<table>
${chatRow(daysAgo(6), "self_owner", "IMAGE")}
</table>`;

// bob_former: DELETED_FRIEND, no chat/snap subpages at all -> no history.

// ivy_otherlast: OTHER sent last.
subpages["html/chat_history/ivy_otherlast_chat_history.html"] = `<table>
${chatRow(daysAgo(50), "self_owner")}
${chatRow(daysAgo(2), "ivy_otherlast")}
</table>`;

// jack_dup: current + former duplicate categories; has some chat history.
subpages["html/chat_history/jack_dup_chat_history.html"] = `<table>
${chatRow(daysAgo(15), "jack_dup")}
</table>`;

// mia_nosnap_haschat: has chat, no snap.
subpages["html/chat_history/mia_nosnap_haschat_chat_history.html"] = `<table>
${chatRow(daysAgo(40), "self_owner")}
</table>`;

// erin_inactive6mo: ~ 220 days ago
subpages["html/chat_history/erin_inactive6mo_chat_history.html"] = `<table>
${chatRow(daysAgo(220), "self_owner")}
</table>`;

// frank_inactive1y: ~400 days ago
subpages["html/chat_history/frank_inactive1y_chat_history.html"] = `<table>
${chatRow(daysAgo(400), "self_owner")}
</table>`;

// grace_inactive2y: ~800 days ago
subpages["html/chat_history/grace_inactive2y_chat_history.html"] = `<table>
${chatRow(daysAgo(800), "self_owner")}
</table>`;

// leo_nochat_hassnap: only snap history.
subpages["html/snap_history/leo_nochat_hassnap_snap_history.html"] = `<table>
${chatRow(daysAgo(30), "self_owner", "IMAGE")}
</table>`;

// henry_nohist: current friend, no chat/snap subpage at all -> no interaction history.
// karen_nodates: sent request with unparseable/missing date -> requestDate null.
// dave_pending, carol_sentonly: no history subpages either.

const files = {
  "html/friends.html": strToU8(friendsHtml),
  "html/account.html": strToU8(accountHtml),
  "html/chat_history.html": strToU8(chatHistoryHtml),
  "html/snap_history.html": strToU8(snapHistoryHtml),
};
for (const [path, html] of Object.entries(subpages)) {
  files[path] = strToU8(`<!doctype html><html><body>${html}</body></html>`);
}

const zipped = zipSync(files, { level: 0 });
mkdirSync(`${__dirname}/fixtures`, { recursive: true });
writeFileSync(`${__dirname}/fixtures/snapchat_my_data_test.zip`, zipped);

// Also dump the expected "now" reference and a couple of derived facts so the
// test runner doesn't need to re-derive day math independently.
writeFileSync(
  `${__dirname}/fixtures/expected.json`,
  JSON.stringify({ generatedAt: now }, null, 2)
);

console.log("Fixture ZIP written:", `${__dirname}/fixtures/snapchat_my_data_test.zip`);
