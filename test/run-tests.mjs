// Lightweight test runner (no external test framework) for parser.js and
// engine.js. Run with: node test/run-tests.mjs
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(msg);
    console.error("FAIL:", msg);
  }
}

function assertEqual(actual, expected, msg) {
  assert(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ---- load fflate + parser.js + engine.js into a shared globalThis ----------
globalThis.fflate = require("fflate");
require("../js/engine.js");
require("../js/parser.js");
const Engine = globalThis.SnapCleanEngine;
const Parser = globalThis.SnapCleanParser;

async function main() {
  const zipBytes = new Uint8Array(readFileSync(`${__dirname}/fixtures/snapchat_my_data_test.zip`));

  const progressStages = [];
  const result = await Parser.parseSnapchatZip(zipBytes, (stage) => progressStages.push(stage));

  assert(progressStages.includes("friends"), "progress callback should report the 'friends' stage");
  assert(progressStages.includes("building"), "progress callback should report the 'building' stage");
  assertEqual(result.selfUsernameKey, "self_owner", "self username should be parsed from account.html");

  const byUser = new Map(result.accounts.map((a) => [a.usernameKey, a]));
  const get = (u) => {
    const a = byUser.get(u);
    assert(!!a, `account "${u}" should exist after parsing`);
    return a || {};
  };

  // --- relationship flags / state derivation -------------------------------
  const alice = get("alice_current");
  assert(Engine.hasFlag(alice, "CURRENT_FRIEND"), "alice should be flagged CURRENT_FRIEND");
  assertEqual(Engine.deriveRelationshipState(alice), "Current Friend", "alice relationship state");

  const bob = get("bob_former");
  assert(Engine.hasFlag(bob, "DELETED_FRIEND") && !Engine.hasFlag(bob, "CURRENT_FRIEND"), "bob should be a former friend only");
  assertEqual(Engine.deriveRelationshipState(bob), "Former Friend • Not Current", "bob relationship state");
  assertEqual(bob.chatHistoryExists, false, "bob should have no chat history");
  assertEqual(bob.snapHistoryExists, false, "bob should have no snap history");

  const carol = get("carol_sentonly");
  assertEqual(
    Engine.deriveRelationshipState(carol),
    "No Recorded Friendship After Sent Request",
    "carol (sent request, never friended) relationship state must not claim rejection"
  );

  const dave = get("dave_pending");
  assertEqual(Engine.deriveRelationshipState(dave), "Pending Request", "dave relationship state");

  const jack = get("jack_dup");
  assert(
    Engine.hasFlag(jack, "CURRENT_FRIEND") && Engine.hasFlag(jack, "DELETED_FRIEND"),
    "jack should carry both CURRENT_FRIEND and DELETED_FRIEND flags (duplicate-category case)"
  );
  assertEqual(Engine.deriveRelationshipState(jack), "Current Friend", "current status should win display precedence over former");

  // --- chat/snap existence + authorship -------------------------------------
  const henry = get("henry_nohist");
  assertEqual(henry.chatHistoryExists, false, "henry should have no chat history");
  assertEqual(henry.snapHistoryExists, false, "henry should have no snap history");
  assertEqual(henry.lastInteraction, null, "henry should have null lastInteraction");

  const leo = get("leo_nochat_hassnap");
  assertEqual(leo.chatHistoryExists, false, "leo should have no chat history");
  assertEqual(leo.snapHistoryExists, true, "leo should have snap history");

  const mia = get("mia_nosnap_haschat");
  assertEqual(mia.chatHistoryExists, true, "mia should have chat history");
  assertEqual(mia.snapHistoryExists, false, "mia should have no snap history");

  assertEqual(alice.lastAuthoredBy, "SELF", "alice's latest authored message should be attributed to SELF");
  // alice's last SELF-authored chat message (5 days ago) is more recent than
  // her last snap (6 days ago), so CHAT should win as the overall latest.
  assertEqual(alice.lastAuthoredKind, "CHAT", "alice's overall latest authored event should be the more recent CHAT");

  const ivy = get("ivy_otherlast");
  assertEqual(ivy.lastAuthoredBy, "OTHER", "ivy's latest authored message should be attributed to OTHER");

  const karen = get("karen_nodates");
  assertEqual(karen.requestDate, null, "karen should have a null requestDate when no date is present in the export");

  // --- STATUS-only rows must not count as an authored event -----------------
  // alice's chat has a STATUS-only row 3 days ago that is more recent than her
  // last authored SELF chat message (5 days ago); it must be ignored for
  // authorship but the interaction timestamp should still reflect *a* signal.
  assert(alice.lastChatInteraction != null, "alice should have a non-null lastChatInteraction");

  // --- priority engine --------------------------------------------------------
  const carolScore = Engine.computeCleanupPriority(carol);
  assert(carolScore.score >= 55, `carol (sent, no record, 400+ days) should score highly, got ${carolScore.score}`);
  assert(carolScore.reasons.length > 0, "carol should have explainable reasons");

  const bobScore = Engine.computeCleanupPriority(bob);
  assert(bobScore.score >= 40, `bob (former friend) should score at least the former-friend baseline, got ${bobScore.score}`);

  const grace = get("grace_inactive2y");
  const graceScore = Engine.computeCleanupPriority(grace);
  const graceReasonLabels = graceScore.reasons.map((r) => r.label);
  assert(graceReasonLabels.some((l) => l.includes("2+ years")), "grace should get the 2+ years inactive reason");

  const frank = get("frank_inactive1y");
  const frankScore = Engine.computeCleanupPriority(frank);
  assert(
    frankScore.reasons.some((r) => r.label.includes("1+ year")),
    "frank should get the 1+ year inactive reason"
  );

  const erin = get("erin_inactive6mo");
  const erinScore = Engine.computeCleanupPriority(erin);
  assert(
    erinScore.reasons.some((r) => r.label.includes("6+ months")),
    "erin should get the 6+ months inactive reason"
  );

  assert(carolScore.score > frankScore.score, "sent-request-no-record should outrank a merely 1y-inactive current friend");

  // --- filters ------------------------------------------------------------
  assert(Engine.matchesFilter(carol, "likely_never_friends"), "carol should match 'likely never became friends'");
  assert(Engine.matchesFilter(bob, "former_friends"), "bob should match 'former friends'");
  assert(Engine.matchesFilter(dave, "pending_requests"), "dave should match 'pending requests'");
  assert(Engine.matchesFilter(henry, "no_interaction_history"), "henry should match 'no interaction history'");
  assert(Engine.matchesFilter(leo, "no_chat_history"), "leo should match 'no chat history'");
  assert(Engine.matchesFilter(mia, "no_snap_history"), "mia should match 'no snap history'");
  assert(Engine.matchesFilter(grace, "inactive_2y"), "grace should match 'inactive 2+ years'");
  assert(!Engine.matchesFilter(alice, "inactive_6mo"), "alice (recent activity) should NOT match 'inactive 6+ months'");

  // --- sorting --------------------------------------------------------------
  const sortedByPriority = Engine.sortAccounts(
    result.accounts.map((a) => ({ ...a, cleanupPriority: Engine.computeCleanupPriority(a).score })),
    "highest_priority"
  );
  for (let i = 1; i < sortedByPriority.length; i++) {
    assert(
      sortedByPriority[i - 1].cleanupPriority >= sortedByPriority[i].cleanupPriority,
      "sortAccounts(highest_priority) must be non-increasing"
    );
  }

  // --- import counts ----------------------------------------------------
  assertEqual(result.counts.total, result.accounts.length, "counts.total should equal accounts.length");
  assert(result.counts.chatMatched >= 7, "chat index should have matched at least 7 subpages");
  assert(result.counts.snapMatched >= 2, "snap index should have matched at least 2 subpages");

  // --- error handling: missing friends.html should throw a typed error ------
  let threw = null;
  try {
    await Parser.parseSnapchatZip(globalThis.fflate.zipSync({ "html/account.html": globalThis.fflate.strToU8("x") }), () => {});
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof Parser.SnapCleanParseError, "missing friends.html should throw SnapCleanParseError");
  assertEqual(threw && threw.code, "FRIENDS_HTML_NOT_FOUND", "error code for missing friends.html");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
