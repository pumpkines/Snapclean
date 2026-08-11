// engine.js — pure, testable logic: relationship state, cleanup priority scoring,
// filters, and sorting. No DOM, no IndexedDB, no fetch. Safe to run in Node for
// unit tests (see test/engine.test.mjs) or in the browser.

(function (global) {
  "use strict";

  const DAY_MS = 86400000;

  function ageDays(timestamp, now) {
    if (timestamp == null) return null;
    const nowMs = now == null ? Date.now() : now;
    return Math.floor((nowMs - timestamp) / DAY_MS);
  }

  function hasFlag(account, flag) {
    return Array.isArray(account.relationshipFlags) && account.relationshipFlags.includes(flag);
  }

  /**
   * Derive a human-readable relationship state from the stored flags.
   * Never asserts more than the data can support (see spec: no "they rejected you").
   */
  function deriveRelationshipState(account) {
    const has = (f) => hasFlag(account, f);

    if (has("CURRENT_FRIEND")) return "Current Friend";
    if (has("DELETED_FRIEND")) return "Former Friend • Not Current";
    if (has("SENT_REQUEST") && !has("DELETED_FRIEND")) {
      return "No Recorded Friendship After Sent Request";
    }
    if (has("PENDING_REQUEST")) return "Pending Request";
    if (has("BLOCKED")) return "Blocked";
    if (has("IGNORED")) return "Ignored";
    if (has("HIDDEN_SUGGESTION")) return "Hidden Suggestion";
    return "Unknown Relationship";
  }

  /**
   * Short state key used for filter matching / styling (stable, not localized).
   */
  function deriveStateKey(account) {
    const has = (f) => hasFlag(account, f);
    if (has("CURRENT_FRIEND")) return "CURRENT_FRIEND";
    if (has("DELETED_FRIEND")) return "FORMER_FRIEND";
    if (has("SENT_REQUEST") && !has("DELETED_FRIEND")) return "SENT_NO_RECORD";
    if (has("PENDING_REQUEST")) return "PENDING";
    if (has("BLOCKED")) return "BLOCKED";
    if (has("IGNORED")) return "IGNORED";
    if (has("HIDDEN_SUGGESTION")) return "HIDDEN_SUGGESTION";
    return "UNKNOWN";
  }

  /**
   * Compute an explainable 0-100 cleanup-priority score plus the reasons that
   * produced it. Reasons are additive point contributions so the UI can show
   * "Priority 92/100 — Former friend +40, 2+ years inactive +30, ...".
   */
  function computeCleanupPriority(account, now) {
    const has = (f) => hasFlag(account, f);
    const reasons = [];
    let score = 0;

    const add = (label, points) => {
      if (points <= 0) return;
      reasons.push({ label, points });
      score += points;
    };

    const days = ageDays(account.lastInteraction, now);
    const currentFriend = has("CURRENT_FRIEND");
    const formerFriend = has("DELETED_FRIEND") && !currentFriend;
    const sentNoRecord = has("SENT_REQUEST") && !currentFriend && !has("DELETED_FRIEND");
    const sentNotCurrent = has("SENT_REQUEST") && !currentFriend;
    const pendingNotCurrent = has("PENDING_REQUEST") && !currentFriend;

    // --- Baseline relationship-state score (mutually exclusive tiers) ------
    if (sentNoRecord) {
      add("Sent request • no recorded friendship", 55);
    } else if (formerFriend) {
      add("Former friend • not current", 40);
    } else if (pendingNotCurrent) {
      add("Pending request • not current", 35);
    } else if (sentNotCurrent) {
      add("Sent request • not current", 30);
    } else if (currentFriend && !account.lastInteraction) {
      add("Current friend • no recorded chat/Snap activity", 22);
    }

    // --- Inactivity add-ons (apply broadly, capped so tiers stay ordered) --
    if (days != null) {
      if (days > 730) add("2+ years inactive", 30);
      else if (days > 365) add("1+ year inactive", 20);
      else if (days > 180) add("6+ months inactive", 10);
    }

    // --- Secondary signals ---------------------------------------------
    if (account.lastAuthoredBy === "SELF") {
      add("You sent last", 12);
    }
    if (!account.chatHistoryExists && !account.snapHistoryExists) {
      add("No recorded chat or Snap history", 8);
    } else if (!account.snapHistoryExists) {
      add("No recent Snap history", 4);
    }

    const requestDays = ageDays(account.requestDate, now);
    if ((sentNoRecord || pendingNotCurrent) && requestDays != null && requestDays > 365) {
      add("Extremely old request (1+ year)", 6);
    }

    const friendshipDays = ageDays(account.friendshipStart, now);
    if (currentFriend && friendshipDays != null && friendshipDays > 1460 && days != null && days > 365) {
      add("Very old friendship with little recent activity", 5);
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    return { score, reasons };
  }

  // --- Filters ---------------------------------------------------------

  const FILTERS = [
    { id: "priority_cleanup", label: "Priority Cleanup" },
    { id: "likely_never_friends", label: "Likely Never Became Friends" },
    { id: "former_friends", label: "Former Friends • Not Current" },
    { id: "sent_requests", label: "Sent Requests • Not Current" },
    { id: "pending_requests", label: "Pending Requests" },
    { id: "current_friends", label: "Current Friends" },
    { id: "no_interaction_history", label: "No Interaction History" },
    { id: "no_chat_history", label: "No Chat History" },
    { id: "no_snap_history", label: "No Snap History" },
    { id: "you_sent_last_7d", label: "You Sent Last • 7+ Days" },
    { id: "you_sent_last_30d", label: "You Sent Last • 30+ Days" },
    { id: "inactive_6mo", label: "Inactive 6+ Months" },
    { id: "inactive_1y", label: "Inactive 1+ Year" },
    { id: "inactive_2y", label: "Inactive 2+ Years" },
    { id: "recently_added", label: "Recently Added" },
    { id: "oldest_friends", label: "Oldest Friends" },
    { id: "unreviewed", label: "Unreviewed" },
    { id: "remove_queue", label: "Remove Queue" },
    { id: "later_queue", label: "Later Queue" },
    { id: "keep_queue", label: "Keep Queue" },
    { id: "removal_completed", label: "Removal Completed" },
    { id: "removal_not_completed", label: "Removal Not Completed" },
    { id: "all", label: "All Accounts" },
  ];

  function matchesFilter(account, filterId, now) {
    const has = (f) => hasFlag(account, f);
    const days = ageDays(account.lastInteraction, now);
    const currentFriend = has("CURRENT_FRIEND");

    switch (filterId) {
      case "priority_cleanup":
        return !account.decision || account.decision === "PENDING";
      case "likely_never_friends":
        return has("SENT_REQUEST") && !currentFriend && !has("DELETED_FRIEND");
      case "former_friends":
        return has("DELETED_FRIEND") && !currentFriend;
      case "sent_requests":
        return has("SENT_REQUEST") && !currentFriend;
      case "pending_requests":
        return has("PENDING_REQUEST") && !currentFriend;
      case "current_friends":
        return currentFriend;
      case "no_interaction_history":
        return !account.lastInteraction;
      case "no_chat_history":
        return !account.chatHistoryExists;
      case "no_snap_history":
        return !account.snapHistoryExists;
      case "you_sent_last_7d":
        return account.lastAuthoredBy === "SELF" && days != null && days >= 7;
      case "you_sent_last_30d":
        return account.lastAuthoredBy === "SELF" && days != null && days >= 30;
      case "inactive_6mo":
        return days != null && days > 180;
      case "inactive_1y":
        return days != null && days > 365;
      case "inactive_2y":
        return days != null && days > 730;
      case "recently_added": {
        const d = ageDays(account.friendshipStart, now);
        return d != null && d <= 30;
      }
      case "oldest_friends":
        return currentFriend && account.friendshipStart != null;
      case "unreviewed":
        return !account.decision || account.decision === "PENDING";
      case "remove_queue":
        return account.decision === "REMOVE";
      case "later_queue":
        return account.decision === "LATER";
      case "keep_queue":
        return account.decision === "KEEP";
      case "removal_completed":
        return account.decision === "REMOVE" && !!account.removalCompleted;
      case "removal_not_completed":
        return account.decision === "REMOVE" && !account.removalCompleted;
      case "all":
        return true;
      default:
        return true;
    }
  }

  const SORTS = [
    { id: "highest_priority", label: "Highest Priority" },
    { id: "oldest_interaction", label: "Oldest Interaction" },
    { id: "newest_interaction", label: "Newest Interaction" },
    { id: "oldest_friendship", label: "Oldest Friendship" },
    { id: "newest_friendship", label: "Newest Friendship" },
    { id: "alphabetical", label: "Alphabetical" },
  ];

  // Treat "unknown"/null as maximally old so accounts with no dates still sort
  // predictably instead of jumping around.
  function sortAccounts(accounts, sortId) {
    const list = accounts.slice();
    switch (sortId) {
      case "oldest_interaction":
        return list.sort((a, b) => (a.lastInteraction ?? -Infinity) - (b.lastInteraction ?? -Infinity));
      case "newest_interaction":
        return list.sort((a, b) => (b.lastInteraction ?? -Infinity) - (a.lastInteraction ?? -Infinity));
      case "oldest_friendship":
        return list.sort((a, b) => (a.friendshipStart ?? Infinity) - (b.friendshipStart ?? Infinity));
      case "newest_friendship":
        return list.sort((a, b) => (b.friendshipStart ?? -Infinity) - (a.friendshipStart ?? -Infinity));
      case "alphabetical":
        return list.sort((a, b) =>
          (a.displayName || a.username).localeCompare(b.displayName || b.username, undefined, {
            sensitivity: "base",
          })
        );
      case "highest_priority":
      default:
        return list.sort((a, b) => (b.cleanupPriority ?? 0) - (a.cleanupPriority ?? 0));
    }
  }

  global.SnapCleanEngine = {
    ageDays,
    hasFlag,
    deriveRelationshipState,
    deriveStateKey,
    computeCleanupPriority,
    FILTERS,
    matchesFilter,
    SORTS,
    sortAccounts,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = globalThis.SnapCleanEngine;
}
