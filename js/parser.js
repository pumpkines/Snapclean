// parser.js — turns a Snapchat "My Data" export ZIP into SnapClean account
// records. Deliberately DOM-free (no DOMParser) so this file can run either on
// the main thread or inside a Web Worker (Safari does not expose DOMParser to
// workers). It only ever reads bytes handed to it; it never performs network
// requests.
//
// Everything here is defensive: a missing/renamed section, an unexpected
// table shape, or a malformed subpage should degrade to null/UNKNOWN fields
// and a recorded warning — never a thrown exception that aborts the whole
// import. Fatal errors (e.g. `html/friends.html` missing entirely) throw a
// SnapCleanParseError with a short machine-friendly code and a human message.

(function (global) {
  "use strict";

  class SnapCleanParseError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "SnapCleanParseError";
      this.code = code;
    }
  }

  // ---- tiny HTML helpers (no DOM) -----------------------------------------

  const ENTITY_MAP = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    "#39": "'",
    apos: "'",
    nbsp: " ",
  };

  function decodeEntities(s) {
    return s.replace(/&(#39|#x27|amp|lt|gt|quot|apos|nbsp|#\d+);/gi, (m, code) => {
      if (code[0] === "#") {
        const num = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(num) ? String.fromCharCode(num) : m;
      }
      return ENTITY_MAP[code.toLowerCase()] ?? m;
    });
  }

  function stripTags(html) {
    return decodeEntities(String(html).replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
  }

  function findHeadings(html) {
    const out = [];
    const re = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;
    let m;
    while ((m = re.exec(html))) {
      out.push({ index: m.index, text: stripTags(m[1]) });
    }
    return out;
  }

  function findTables(html) {
    const out = [];
    const re = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    let m;
    while ((m = re.exec(html))) {
      out.push({ index: m.index, body: m[1] });
    }
    return out;
  }

  function parseTableRows(tableBody) {
    const rows = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(tableBody))) {
      const cells = [];
      const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) {
        cells.push(stripTags(cm[1]));
      }
      if (cells.length) rows.push(cells);
    }
    return rows;
  }

  /** Section heading text -> relationship flag, with tolerant synonyms. */
  const HEADING_FLAG_PATTERNS = [
    [/^(my )?friends$/i, "CURRENT_FRIEND"],
    [/friend requests?\s*sent/i, "SENT_REQUEST"],
    [/sent\s*friend requests?/i, "SENT_REQUEST"],
    [/friend requests?\s*received/i, "PENDING_REQUEST"],
    [/received\s*friend requests?/i, "PENDING_REQUEST"],
    [/pending\s*(friend )?requests?/i, "PENDING_REQUEST"],
    [/deleted friends?/i, "DELETED_FRIEND"],
    [/removed friends?/i, "DELETED_FRIEND"],
    [/blocked/i, "BLOCKED"],
    [/ignored/i, "IGNORED"],
    [/hidden.*(friend )?suggestions?/i, "HIDDEN_SUGGESTION"],
  ];

  function flagForHeading(headingText) {
    for (const [pattern, flag] of HEADING_FLAG_PATTERNS) {
      if (pattern.test(headingText.trim())) return flag;
    }
    return null;
  }

  const DATE_RE = /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*(?:UTC|Z)?\b/;

  function parseDate(text) {
    if (!text) return null;
    const m = DATE_RE.exec(text);
    if (!m) return null;
    let s = m[0].trim();
    if (!/UTC|Z$/i.test(s)) s += " UTC";
    s = s.replace(" UTC", "Z").replace(/\s+/, "T").replace("TZ", "Z");
    // Normalize "YYYY-MM-DD HH:MM:SS UTC" -> "YYYY-MM-DDTHH:MM:SSZ"
    const iso = m[0]
      .trim()
      .replace(/\s*UTC$/i, "")
      .replace(/\s*Z$/i, "")
      .replace(" ", "T") + "Z";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  function normalizeUsernameKey(username) {
    return String(username || "").trim().toLowerCase();
  }

  // ---- friends.html --------------------------------------------------------

  /**
   * @returns {{ map: Map<string, object>, warnings: string[] }}
   */
  function parseFriendsHtml(html) {
    const warnings = [];
    const map = new Map();
    const headings = findHeadings(html);
    const tables = findTables(html);

    if (!headings.length || !tables.length) {
      warnings.push("friends.html: no recognizable section headings/tables found.");
      return { map, warnings };
    }

    for (const table of tables) {
      // Nearest preceding heading determines which relationship flag this
      // table represents.
      let heading = null;
      for (const h of headings) {
        if (h.index <= table.index) heading = h;
        else break;
      }
      if (!heading) continue;
      const flag = flagForHeading(heading.text);
      if (!flag) continue;

      let rows;
      try {
        rows = parseTableRows(table.body);
      } catch (err) {
        warnings.push(`friends.html: failed to parse table under "${heading.text}" (${err.message}).`);
        continue;
      }
      if (!rows.length) continue;

      // Detect (and drop) a header row: a row is a header if none of its
      // cells look like a username-and-date data row, i.e. it contains a
      // recognizable column label.
      let dataRows = rows;
      const first = rows[0];
      if (first.some((c) => /^(username|date|reason|source|added|created|deleted)/i.test(c))) {
        dataRows = rows.slice(1);
      }

      for (const cells of dataRows) {
        const username = (cells[0] || "").trim();
        if (!username) continue;
        const usernameKey = normalizeUsernameKey(username);

        let dateValue = null;
        let sourceValue = null;
        for (let i = 1; i < cells.length; i++) {
          const cell = cells[i];
          if (dateValue == null) {
            const d = parseDate(cell);
            if (d != null) {
              dateValue = d;
              continue;
            }
          }
          if (!sourceValue && cell && !DATE_RE.test(cell) && cell.length < 60) {
            sourceValue = cell;
          }
        }

        const existing = map.get(usernameKey) || {
          username,
          usernameKey,
          displayName: username,
          relationshipFlags: [],
          friendshipStart: null,
          requestDate: null,
          source: null,
        };

        if (!existing.relationshipFlags.includes(flag)) existing.relationshipFlags.push(flag);

        if (flag === "CURRENT_FRIEND" || flag === "DELETED_FRIEND") {
          if (dateValue != null && (existing.friendshipStart == null || dateValue < existing.friendshipStart)) {
            existing.friendshipStart = dateValue;
          }
        }
        if (flag === "SENT_REQUEST" || flag === "PENDING_REQUEST") {
          if (dateValue != null && (existing.requestDate == null || dateValue < existing.requestDate)) {
            existing.requestDate = dateValue;
          }
        }
        if (sourceValue && !existing.source) existing.source = sourceValue;

        map.set(usernameKey, existing);
      }
    }

    if (!map.size) {
      warnings.push("friends.html: parsed 0 accounts from recognized sections.");
    }

    return { map, warnings };
  }

  // ---- account.html (self username) ----------------------------------------

  function parseAccountHtml(html) {
    if (!html) return { selfUsernameKey: null };
    try {
      const rowMatch = /<tr[^>]*>\s*<t[dh][^>]*>\s*Username\s*<\/t[dh]>\s*<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/i.exec(html);
      if (rowMatch) return { selfUsernameKey: normalizeUsernameKey(stripTags(rowMatch[1])) };
      const looseMatch = /Username\s*[:\-]?\s*<[^>]*>?\s*([a-zA-Z0-9_.\-]{2,40})/i.exec(html);
      if (looseMatch) return { selfUsernameKey: normalizeUsernameKey(looseMatch[1]) };
    } catch (err) {
      // Non-fatal: self-authorship attribution will fall back to UNKNOWN.
    }
    return { selfUsernameKey: null };
  }

  // ---- chat_history.html / snap_history.html index pages --------------------

  /**
   * Maps a subpage relative path (as it would appear inside the ZIP, rooted
   * at "html/") to the friend's normalized username key.
   * @returns {{ map: Map<string,string>, warnings: string[] }}
   */
  function parseHistoryIndex(html, labelPrefix) {
    const warnings = [];
    const map = new Map();
    if (!html) return { map, warnings };

    const tagRe = /<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let m;
    let found = 0;
    while ((m = tagRe.exec(html))) {
      const attrs = m[2];
      const label = stripTags(m[3]);
      if (!label.toLowerCase().startsWith(labelPrefix.toLowerCase())) continue;

      let path = null;
      const hrefMatch = /href=["']([^"']+)["']/i.exec(attrs);
      const onclickMatch = /onclick=["']([^"']*)["']/i.exec(attrs);
      if (hrefMatch && hrefMatch[1] && hrefMatch[1] !== "#") {
        path = hrefMatch[1];
      } else if (onclickMatch) {
        const locMatch = /location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i.exec(onclickMatch[1]);
        if (locMatch) path = locMatch[1];
      }
      if (!path) continue;

      const username = normalizeUsernameKey(label.slice(labelPrefix.length));
      if (!username) continue;

      const normalizedPath = path.replace(/^\.?\//, "");
      const zipPath = normalizedPath.startsWith("html/") ? normalizedPath : "html/" + normalizedPath;
      map.set(zipPath, username);
      found++;
    }

    if (!found) warnings.push(`No entries matched under "${labelPrefix}" links.`);
    return { map, warnings };
  }

  // ---- individual chat/snap subpages ----------------------------------------

  // A row/window counts as "status-only" when its type/content field is
  // exactly STATUS (e.g. a read receipt), not merely because the word
  // "status" appears somewhere near unrelated text like "Media Type: ...".
  function isStatusOnlyCells(cells) {
    return cells.some((c) => /^status$/i.test(c.trim())) || cells.some((c) => /\btype\s*:\s*status\s*$/i.test(c.trim()));
  }
  function isStatusOnlyText(text) {
    return /\btype\s*:\s*status\b/i.test(text) || /(^|\|)\s*status\s*(\||$)/i.test(text);
  }

  /**
   * Extract the latest timestamp (any row) and the latest *authored* event
   * (excluding status-only rows) with a best-effort SELF/OTHER/UNKNOWN guess.
   */
  function parseHistorySubpage(html, selfUsernameKey, friendUsernameKey) {
    const result = {
      exists: true,
      latestTimestamp: null,
      authoredAt: null,
      authoredBy: "UNKNOWN",
    };
    if (!html) return result;

    /** @type {{ ts:number, statusOnly:boolean, author:string }[]} */
    const events = [];

    const tables = findTables(html);
    if (tables.length) {
      for (const t of tables) {
        let rows;
        try {
          rows = parseTableRows(t.body);
        } catch {
          continue;
        }
        for (const cells of rows) {
          const rowText = cells.join(" | ");
          const ts = parseDate(rowText);
          if (ts == null) continue;
          const statusOnly = isStatusOnlyCells(cells);
          const author = guessAuthor(rowText, selfUsernameKey, friendUsernameKey);
          events.push({ ts, statusOnly, author });
        }
      }
    }

    if (!events.length) {
      // Fallback: no <table> structure recognized — scan raw text around each
      // timestamp occurrence for sender hints.
      const re = new RegExp(DATE_RE.source, "gi");
      let m;
      while ((m = re.exec(html))) {
        const ts = parseDate(m[0]);
        if (ts == null) continue;
        const windowText = stripTags(html.slice(Math.max(0, m.index - 120), m.index + 200));
        const statusOnly = isStatusOnlyText(windowText);
        const author = guessAuthor(windowText, selfUsernameKey, friendUsernameKey);
        events.push({ ts, statusOnly, author });
      }
    }

    if (!events.length) return result;

    result.latestTimestamp = Math.max(...events.map((e) => e.ts));

    const authoredEvents = events.filter((e) => !e.statusOnly);
    if (authoredEvents.length) {
      authoredEvents.sort((a, b) => b.ts - a.ts);
      result.authoredAt = authoredEvents[0].ts;
      result.authoredBy = authoredEvents[0].author;
    }

    return result;
  }

  function guessAuthor(text, selfUsernameKey, friendUsernameKey) {
    const lower = text.toLowerCase();
    const selfMatch =
      /\bfrom\s*[:\-]?\s*you\b/i.test(text) ||
      (selfUsernameKey && new RegExp("\\bfrom\\s*[:\\-]?\\s*" + escapeRe(selfUsernameKey) + "\\b", "i").test(lower)) ||
      (selfUsernameKey && new RegExp("\\bsender\\s*[:\\-]?\\s*" + escapeRe(selfUsernameKey) + "\\b", "i").test(lower));
    if (selfMatch) return "SELF";

    const otherMatch =
      (friendUsernameKey && new RegExp("\\bfrom\\s*[:\\-]?\\s*" + escapeRe(friendUsernameKey) + "\\b", "i").test(lower)) ||
      (friendUsernameKey && new RegExp("\\bsender\\s*[:\\-]?\\s*" + escapeRe(friendUsernameKey) + "\\b", "i").test(lower));
    if (otherMatch) return "OTHER";

    return "UNKNOWN";
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ---- top-level orchestration -----------------------------------------------

  /**
   * @param {Uint8Array} zipBytes
   * @param {(stage:string, detail?:object) => void} onProgress
   */
  async function parseSnapchatZip(zipBytes, onProgress) {
    const notify = (stage, detail) => {
      try {
        onProgress && onProgress(stage, detail);
      } catch {
        /* progress callback must never break parsing */
      }
    };

    if (!global.fflate) {
      throw new SnapCleanParseError("ZIP_LIB_MISSING", "The ZIP library did not load. Check your connection and reopen SnapClean.");
    }

    notify("reading", {});
    let entries;
    try {
      entries = global.fflate.unzipSync(zipBytes);
    } catch (err) {
      throw new SnapCleanParseError("ZIP_UNREADABLE", "This file could not be read as a ZIP archive: " + err.message);
    }

    const textOf = (path) => {
      const bytes = entries[path];
      if (!bytes) return null;
      try {
        return global.fflate.strFromU8(bytes);
      } catch (err) {
        return null;
      }
    };

    // Snapchat has shipped the export at both "html/friends.html" and, in some
    // versions, nested one level deeper (e.g. inside a dated folder). Search
    // defensively instead of assuming the exact root.
    const findEntry = (suffix) => {
      if (entries[suffix]) return suffix;
      const match = Object.keys(entries).find((p) => p.endsWith(suffix));
      return match || null;
    };

    const friendsPath = findEntry("html/friends.html");
    if (!friendsPath) {
      throw new SnapCleanParseError(
        "FRIENDS_HTML_NOT_FOUND",
        "html/friends.html was not found in this export. Make sure you selected your original Snapchat 'My Data' ZIP with the HTML data format."
      );
    }

    const warnings = [];

    notify("friends", {});
    const friendsHtml = textOf(friendsPath);
    const { map: accountMap, warnings: friendWarnings } = parseFriendsHtml(friendsHtml);
    warnings.push(...friendWarnings);

    const accountPath = findEntry("html/account.html");
    const { selfUsernameKey } = parseAccountHtml(accountPath ? textOf(accountPath) : null);

    notify("chats", {});
    const chatIndexPath = findEntry("html/chat_history.html");
    const { map: chatIndex, warnings: chatWarnings } = parseHistoryIndex(
      chatIndexPath ? textOf(chatIndexPath) : null,
      "Chat History with "
    );
    if (chatIndexPath) warnings.push(...chatWarnings);

    notify("snaps", {});
    const snapIndexPath = findEntry("html/snap_history.html");
    const { map: snapIndex, warnings: snapWarnings } = parseHistoryIndex(
      snapIndexPath ? textOf(snapIndexPath) : null,
      "Snap History with "
    );
    if (snapIndexPath) warnings.push(...snapWarnings);

    notify("building", { total: accountMap.size });

    let processed = 0;
    const yieldEvery = 250;

    async function maybeYield() {
      processed++;
      if (processed % yieldEvery === 0) {
        notify("building", { processed, total: chatIndex.size + snapIndex.size });
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    // Ensure every referenced friend (even ones not in friends.html, which
    // shouldn't normally happen but we stay defensive) gets a record.
    const ensureAccount = (usernameKey) => {
      let acc = accountMap.get(usernameKey);
      if (!acc) {
        acc = {
          username: usernameKey,
          usernameKey,
          displayName: usernameKey,
          relationshipFlags: [],
          friendshipStart: null,
          requestDate: null,
          source: null,
        };
        accountMap.set(usernameKey, acc);
      }
      return acc;
    };

    for (const [path, usernameKey] of chatIndex.entries()) {
      const html = textOf(path);
      const acc = ensureAccount(usernameKey);
      const parsed = parseHistorySubpage(html, selfUsernameKey, usernameKey);
      acc.chatHistoryExists = true;
      acc.lastChatInteraction = parsed.latestTimestamp;
      if (parsed.authoredAt != null) {
        acc._chatAuthored = { at: parsed.authoredAt, by: parsed.authoredBy };
      }
      await maybeYield();
    }

    for (const [path, usernameKey] of snapIndex.entries()) {
      const html = textOf(path);
      const acc = ensureAccount(usernameKey);
      const parsed = parseHistorySubpage(html, selfUsernameKey, usernameKey);
      acc.snapHistoryExists = true;
      acc.lastSnapInteraction = parsed.latestTimestamp;
      if (parsed.authoredAt != null) {
        acc._snapAuthored = { at: parsed.authoredAt, by: parsed.authoredBy };
      }
      await maybeYield();
    }

    // Finalize derived interaction fields per spec's data model.
    const accounts = [];
    for (const acc of accountMap.values()) {
      acc.chatHistoryExists = !!acc.chatHistoryExists;
      acc.snapHistoryExists = !!acc.snapHistoryExists;
      acc.lastChatInteraction = acc.lastChatInteraction ?? null;
      acc.lastSnapInteraction = acc.lastSnapInteraction ?? null;
      acc.lastInteraction =
        acc.lastChatInteraction != null && acc.lastSnapInteraction != null
          ? Math.max(acc.lastChatInteraction, acc.lastSnapInteraction)
          : acc.lastChatInteraction ?? acc.lastSnapInteraction ?? null;

      const chatA = acc._chatAuthored;
      const snapA = acc._snapAuthored;
      if (chatA && snapA) {
        if (chatA.at >= snapA.at) {
          acc.lastAuthoredAt = chatA.at;
          acc.lastAuthoredBy = chatA.by;
          acc.lastAuthoredKind = "CHAT";
        } else {
          acc.lastAuthoredAt = snapA.at;
          acc.lastAuthoredBy = snapA.by;
          acc.lastAuthoredKind = "SNAP";
        }
      } else if (chatA) {
        acc.lastAuthoredAt = chatA.at;
        acc.lastAuthoredBy = chatA.by;
        acc.lastAuthoredKind = "CHAT";
      } else if (snapA) {
        acc.lastAuthoredAt = snapA.at;
        acc.lastAuthoredBy = snapA.by;
        acc.lastAuthoredKind = "SNAP";
      } else {
        acc.lastAuthoredAt = null;
        acc.lastAuthoredBy = "UNKNOWN";
        acc.lastAuthoredKind = "UNKNOWN";
      }
      delete acc._chatAuthored;
      delete acc._snapAuthored;

      accounts.push(acc);
    }

    return {
      accounts,
      warnings,
      selfUsernameKey,
      counts: {
        total: accounts.length,
        chatMatched: chatIndex.size,
        snapMatched: snapIndex.size,
      },
    };
  }

  global.SnapCleanParser = {
    SnapCleanParseError,
    parseFriendsHtml,
    parseAccountHtml,
    parseHistoryIndex,
    parseHistorySubpage,
    parseSnapchatZip,
    normalizeUsernameKey,
    parseDate,
    stripTags,
  };
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).SnapCleanParser;
}
