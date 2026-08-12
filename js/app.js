// app.js — SnapClean UI controller. Vanilla JS, no framework, no bundler.
// Talks to IndexedDB via SnapCleanDB (js/db.js), pure logic via SnapCleanEngine
// (js/engine.js), and the ZIP/HTML import via SnapCleanParser (js/parser.js).

(function () {
  "use strict";

  const DB = window.SnapCleanDB;
  const Engine = window.SnapCleanEngine;
  const Parser = window.SnapCleanParser;
  const IMPORT_VERSION = 1;

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...children) => {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") node.className = v;
        else if (k === "html") node.innerHTML = v;
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
        else if (v !== null && v !== undefined) node.setAttribute(k, v);
      }
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

  // ---- global state ---------------------------------------------------------

  const state = {
    accounts: [],
    byKey: new Map(),
    ready: false,
    review: { filterId: "priority_cleanup", sortId: "highest_priority", cursorKey: null, skipSet: new Set() },
    search: { term: "", limit: 150 },
    undoCount: 0,
    pendingRemoval: null,
    lastImport: null,
    pendingReturnTo: "#/dashboard",
  };

  function recomputeAll() {
    const now = Date.now();
    for (const a of state.accounts) {
      const { score, reasons } = Engine.computeCleanupPriority(a, now);
      a.cleanupPriority = score;
      a.cleanupReasons = reasons;
    }
  }

  async function loadFromDB() {
    state.accounts = await DB.getAllAccounts();
    state.byKey = new Map(state.accounts.map((a) => [a.usernameKey, a]));
    recomputeAll();
    state.undoCount = await DB.peekUndoCount();
    state.lastImport = await DB.getMeta("lastImport", null);
    const savedReview = await DB.getMeta("reviewState", null);
    if (savedReview) state.review = Object.assign(state.review, savedReview, { skipSet: new Set() });
    state.ready = true;
  }

  async function persistDecision(account, patch) {
    Object.assign(account, patch, { updatedAt: Date.now() });
    await DB.putAccount(account);
  }

  async function saveReviewState() {
    const { filterId, sortId, cursorKey } = state.review;
    await DB.setMeta("reviewState", { filterId, sortId, cursorKey });
  }

  // ---- router ----------------------------------------------------------------

  const routes = {};
  function route(pattern, handler) {
    routes[pattern] = handler;
  }
  function navigate(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }
  window.addEventListener("hashchange", render);
  window.addEventListener("pageshow", render);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") render();
  });

  function currentRoute() {
    const hash = location.hash || "#/dashboard";
    const [path, query] = hash.slice(1).split("?");
    const parts = path.split("/").filter(Boolean);
    const params = new URLSearchParams(query || "");
    return { parts, params };
  }

  // ---- app shell ---------------------------------------------------------

  const app = $("app");

  function setContent(node) {
    app.querySelector("#view").replaceChildren(node);
    app.querySelector("#view").scrollTop = 0;
  }

  function render() {
    if (!state.ready) return;
    const { parts } = currentRoute();
    const top = parts[0] || "dashboard";

    if (!state.accounts.length && top !== "settings") {
      setContent(renderImportView());
      return;
    }

    if (top !== "removal") state.pendingRemoval = null;

    switch (top) {
      case "dashboard":
        setContent(renderDashboard());
        break;
      case "browse":
        setContent(renderBrowse());
        break;
      case "review":
        state.review.filterId = parts[1] || state.review.filterId;
        state.review.sortId = parts[2] || state.review.sortId;
        setContent(renderReview());
        break;
      case "removal":
        setContent(renderRemovalQueue());
        break;
      case "later":
        setContent(renderLaterQueue());
        break;
      case "search":
        setContent(renderSearch());
        break;
      case "detail":
        setContent(renderDetail(parts[1]));
        break;
      case "settings":
        setContent(renderSettings());
        break;
      default:
        setContent(renderDashboard());
    }
  }

  // ---- shared card renderer (Review / Later / Detail) -------------------------

  function fmtDate(t) {
    return t ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "Not recorded";
  }
  function fmtRelative(t) {
    if (!t) return "No recorded activity";
    const days = Engine.ageDays(t);
    if (days <= 0) return "Today";
    if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
    if (days < 365) {
      const m = Math.floor(days / 30);
      return `${m} month${m === 1 ? "" : "s"} ago`;
    }
    return `${(days / 365).toFixed(1)} years ago`;
  }
  function stateBadgeClass(stateKey) {
    return (
      {
        CURRENT_FRIEND: "badge-current",
        FORMER_FRIEND: "badge-former",
        SENT_NO_RECORD: "badge-sent",
        PENDING: "badge-pending",
        BLOCKED: "badge-blocked",
        IGNORED: "badge-blocked",
        HIDDEN_SUGGESTION: "badge-blocked",
      }[stateKey] || "badge-unknown"
    );
  }

  function snapchatUrl(username) {
    return `https://www.snapchat.com/add/${encodeURIComponent(username)}`;
  }

  // ---- Bitmoji / Public Profile preview --------------------------------
  // Uses Snapchat's own, officially documented Web Embeds feature (public
  // profiles are one of the four embeddable content types Snap supports —
  // see developers.snap.com/api/snapchat-for-web/social-plugins). This is a
  // sanctioned public API, not scraping: it loads Snapchat's own widget
  // script, which then renders an iframe Snapchat controls. No login, no
  // private endpoints. It's opt-in per card (tap to expand) rather than
  // automatic, since expanding it does make a request to snapchat.com for
  // that specific person.

  function triggerSnapEmbedScan() {
    // These widget loaders scan the whole document for un-rendered
    // `.snapchat-embed` blockquotes each time they execute. Re-inserting a
    // fresh <script> is the standard, safe way to ask it to re-scan after
    // SnapClean has added a new embed to the page (already-rendered embeds
    // are left alone).
    document.querySelectorAll("script[data-snap-embed-loader]").forEach((s) => s.remove());
    const s = document.createElement("script");
    s.src = "https://www.snapchat.com/embed.js";
    s.async = true;
    s.setAttribute("data-snap-embed-loader", "1");
    document.body.appendChild(s);
  }

  function buildProfilePreview(username) {
    const url = snapchatUrl(username);
    const toggleBtn = el("button", { class: "profileToggle" }, "Show Bitmoji / Public Profile");
    const container = el("div", { class: "profilePreview hidden" });

    toggleBtn.addEventListener("click", () => {
      const hidden = container.classList.contains("hidden");
      if (hidden) {
        container.classList.remove("hidden");
        toggleBtn.textContent = "Hide Preview";
        if (!container.dataset.loaded) {
          container.dataset.loaded = "1";
          container.appendChild(
            el(
              "blockquote",
              {
                class: "snapchat-embed",
                "data-snapchat-embed-url": `${url}/embed`,
              },
              el("a", { href: url, target: "_blank", rel: "noopener" }, "View profile on Snapchat")
            )
          );
          container.appendChild(
            el("p", { class: "embedNote" }, "Loads Snapchat's official public-profile embed — this contacts snapchat.com.")
          );
          triggerSnapEmbedScan();
          setTimeout(() => {
            if (container.isConnected && !container.querySelector("iframe")) {
              container.appendChild(
                el("p", { class: "muted embedFallback" }, "Preview didn't load for this account — use View in Snapchat instead.")
              );
            }
          }, 4000);
        }
      } else {
        container.classList.add("hidden");
        toggleBtn.textContent = "Show Bitmoji / Public Profile";
      }
    });

    return el("div", { class: "profilePreviewBlock" }, toggleBtn, container);
  }

  function reasonsHtml(reasons) {
    if (!reasons || !reasons.length) return "";
    return el(
      "div",
      { class: "reasons" },
      ...reasons.map((r) => el("div", { class: "reason" }, el("span", null, r.label), el("b", null, `+${r.points}`)))
    );
  }

  function buildCard(account, opts = {}) {
    const stateKey = Engine.deriveStateKey(account);
    const stateLabel = Engine.deriveRelationshipState(account);
    const card = el(
      "article",
      { class: "card", id: "reviewCard" },
      el(
        "div",
        { class: "scoreRow" },
        el("span", { class: `pill ${stateBadgeClass(stateKey)}` }, stateLabel),
        el("span", { class: "priority" }, `Priority ${account.cleanupPriority ?? 0} / 100`)
      ),
      el("h2", { class: "displayName" }, account.displayName || account.username),
      el("div", { class: "username" }, "@" + account.username),
      el(
        "dl",
        { class: "facts" },
        el("div", null, el("dt", null, "Friends since"), el("dd", null, fmtDate(account.friendshipStart))),
        account.requestDate
          ? el("div", null, el("dt", null, "Request date"), el("dd", null, fmtDate(account.requestDate)))
          : null,
        el("div", null, el("dt", null, "Last activity"), el("dd", null, fmtRelative(account.lastInteraction))),
        el(
          "div",
          null,
          el("dt", null, "Last identifiable sender"),
          el("dd", null, account.lastAuthoredBy === "SELF" ? "You" : account.lastAuthoredBy === "OTHER" ? "Them" : "Unknown")
        ),
        el(
          "div",
          null,
          el("dt", null, "Chat / Snap history"),
          el(
            "dd",
            null,
            `${account.chatHistoryExists ? "Chat found" : "No chat"} • ${account.snapHistoryExists ? "Snap found" : "No Snap"}`
          )
        ),
        el("div", null, el("dt", null, "Decision"), el("dd", null, account.decision || "PENDING"))
      ),
      reasonsHtml(account.cleanupReasons),
      el(
        "a",
        { class: "snapBtn", href: snapchatUrl(account.username), target: "_blank", rel: "noopener" },
        "VIEW IN SNAPCHAT"
      ),
      buildProfilePreview(account.username)
    );
    return card;
  }

  // ---- swipe gesture handling ------------------------------------------------

  function attachSwipe(cardWrap, { onKeep, onRemove, onLater, labels }) {
    let card = cardWrap.querySelector("#reviewCard");
    if (!card) return;
    const L = Object.assign({ keep: "KEEP", remove: "REMOVE", later: "LATER" }, labels);
    let startX = 0,
      startY = 0,
      dx = 0,
      dy = 0,
      dragging = false;
    const threshold = 90;

    const indicator = el("div", { class: "swipeIndicator" });
    cardWrap.appendChild(indicator);

    function updateVisual() {
      const rot = dx / 18;
      card.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
      const absX = Math.abs(dx);
      if (absX > 20 && absX > Math.abs(dy)) {
        indicator.textContent = dx > 0 ? L.keep : L.remove;
        indicator.className = `swipeIndicator show ${dx > 0 ? "keep" : "remove"}`;
        indicator.style.opacity = Math.min(1, absX / threshold);
      } else if (dy < -20 && onLater) {
        indicator.textContent = L.later;
        indicator.className = "swipeIndicator show later";
        indicator.style.opacity = Math.min(1, Math.abs(dy) / threshold);
      } else {
        indicator.className = "swipeIndicator";
      }
    }

    function reset() {
      dx = 0;
      dy = 0;
      card.style.transition = "transform 0.2s ease";
      card.style.transform = "";
      indicator.className = "swipeIndicator";
      setTimeout(() => {
        if (card) card.style.transition = "";
      }, 200);
    }

    function commit(direction) {
      card.style.transition = "transform 0.25s ease, opacity 0.25s ease";
      card.style.opacity = "0";
      if (direction === "keep") card.style.transform = `translate(600px, ${dy}px) rotate(20deg)`;
      else if (direction === "remove") card.style.transform = `translate(-600px, ${dy}px) rotate(-20deg)`;
      else card.style.transform = `translate(${dx}px, -600px)`;
      setTimeout(() => {
        if (direction === "keep") onKeep();
        else if (direction === "remove") onRemove();
        else onLater();
      }, 180);
    }

    function onDown(e) {
      dragging = true;
      startX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
      startY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
      card.setPointerCapture && e.pointerId != null && card.setPointerCapture(e.pointerId);
    }
    function onMove(e) {
      if (!dragging) return;
      const x = e.clientX ?? e.touches?.[0]?.clientX ?? startX;
      const y = e.clientY ?? e.touches?.[0]?.clientY ?? startY;
      dx = x - startX;
      dy = y - startY;
      updateVisual();
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      if (absX > threshold && absX > absY) {
        commit(dx > 0 ? "keep" : "remove");
      } else if (onLater && dy < -threshold && absY > absX) {
        commit("later");
      } else {
        reset();
      }
    }

    card.addEventListener("pointerdown", onDown);
    card.addEventListener("pointermove", onMove);
    card.addEventListener("pointerup", onUp);
    card.addEventListener("pointercancel", onUp);
  }

  // ---- Review (Tinder) view ------------------------------------------------

  function computeQueue(filterId, sortId) {
    const now = Date.now();
    const filtered = state.accounts.filter((a) => Engine.matchesFilter(a, filterId, now));
    return Engine.sortAccounts(filtered, sortId);
  }

  function renderReview() {
    const { filterId, sortId } = state.review;
    const queue = computeQueue(filterId, sortId);

    let idx = queue.findIndex((a) => a.usernameKey === state.review.cursorKey);
    if (idx === -1) idx = 0;
    const account = queue[idx];

    const filterMeta = Engine.FILTERS.find((f) => f.id === filterId) || Engine.FILTERS[0];

    const filterSelect = el(
      "select",
      { class: "filterSelect", onchange: (e) => navigate(`#/review/${e.target.value}/${sortId}`) },
      ...Engine.FILTERS.map((f) => el("option", { value: f.id, selected: f.id === filterId ? "" : null }, f.label))
    );
    const sortSelect = el(
      "select",
      { class: "sortSelect", onchange: (e) => navigate(`#/review/${filterId}/${e.target.value}`) },
      ...Engine.SORTS.map((s) => el("option", { value: s.id, selected: s.id === sortId ? "" : null }, s.label))
    );

    const wrap = el(
      "section",
      { class: "reviewView" },
      el(
        "div",
        { class: "toolbar" },
        el("button", { class: "iconBtn", onclick: () => navigate("#/dashboard") }, "←"),
        filterSelect,
        sortSelect
      ),
      el("div", { class: "progress" }, queue.length ? `${idx + 1} / ${queue.length}` : "0 / 0")
    );

    const cardWrap = el("div", { class: "cardWrap" });
    wrap.appendChild(cardWrap);

    if (!account) {
      cardWrap.appendChild(
        el(
          "div",
          { class: "emptyState" },
          el("h2", null, "Queue complete"),
          el("p", null, `No accounts currently match "${filterMeta.label}".`),
          el("button", { class: "primary", onclick: () => navigate("#/dashboard") }, "Back to dashboard")
        )
      );
    } else {
      cardWrap.appendChild(buildCard(account));
      state.review.cursorKey = account.usernameKey;
      saveReviewState();

      const advance = (decidedKey, previousQueue, previousIdx) => {
        const newQueue = computeQueue(state.review.filterId, state.review.sortId);
        const stillIdx = newQueue.findIndex((a) => a.usernameKey === decidedKey);
        const nextAccount = stillIdx === -1 ? newQueue[previousIdx] : newQueue[stillIdx + 1];
        state.review.cursorKey = nextAccount ? nextAccount.usernameKey : null;
        saveReviewState();
        render();
      };

      const decide = async (decision) => {
        await DB.pushUndo({
          type: "decision",
          usernameKey: account.usernameKey,
          prevDecision: account.decision || "PENDING",
          view: "review",
        });
        state.undoCount++;
        await persistDecision(account, { decision });
        advance(account.usernameKey, queue, idx);
      };

      attachSwipe(cardWrap, {
        onKeep: () => decide("KEEP"),
        onRemove: () => decide("REMOVE"),
        onLater: () => decide("LATER"),
      });

      wrap.appendChild(
        el(
          "div",
          { class: "actions" },
          el("button", { class: "remove", onclick: () => decide("REMOVE") }, "✕", el("small", null, "REMOVE")),
          el("button", { class: "later", onclick: () => decide("LATER") }, "?", el("small", null, "LATER")),
          el("button", { class: "keep", onclick: () => decide("KEEP") }, "♥", el("small", null, "KEEP"))
        )
      );
    }

    wrap.appendChild(
      el(
        "button",
        { class: "textBtn", disabled: state.undoCount ? null : "disabled", onclick: onUndo },
        `Undo last decision${state.undoCount ? ` (${state.undoCount})` : ""}`
      )
    );

    return wrap;
  }

  async function onUndo() {
    const entry = await DB.popUndo();
    if (!entry) return;
    state.undoCount = Math.max(0, state.undoCount - 1);
    if (entry.type === "decision") {
      const acc = state.byKey.get(entry.usernameKey);
      if (acc) {
        await persistDecision(acc, { decision: entry.prevDecision });
        state.review.cursorKey = entry.usernameKey;
      }
    } else if (entry.type === "removal") {
      const acc = state.byKey.get(entry.usernameKey);
      if (acc) {
        await persistDecision(acc, { removalCompleted: entry.prevRemovalCompleted, removalCompletedAt: entry.prevRemovalCompletedAt });
      }
    }
    render();
  }

  // ---- Removal Queue ----------------------------------------------------

  function renderRemovalQueue() {
    const allRemove = state.accounts.filter((a) => a.decision === "REMOVE");
    const remaining = allRemove.filter((a) => !a.removalCompleted && !state.review.skipSet.has(a.usernameKey));
    const completedCount = allRemove.filter((a) => a.removalCompleted).length;
    const account = remaining[0];

    const wrap = el(
      "section",
      { class: "reviewView" },
      el(
        "div",
        { class: "toolbar" },
        el("button", { class: "iconBtn", onclick: () => navigate("#/dashboard") }, "←"),
        el("h2", null, "Removal Queue")
      ),
      el("div", { class: "progress" }, `${completedCount} / ${allRemove.length} removals completed`)
    );

    if (!allRemove.length) {
      wrap.appendChild(el("div", { class: "emptyState" }, el("p", null, "Nothing is in your Remove queue yet.")));
      return wrap;
    }
    if (!account) {
      wrap.appendChild(
        el(
          "div",
          { class: "emptyState" },
          el("h2", null, "All caught up"),
          el("p", null, "Every account in your Remove queue is marked completed.")
        )
      );
      return wrap;
    }

    const markRemoved = async (opts = {}) => {
      await DB.pushUndo({
        type: "removal",
        usernameKey: account.usernameKey,
        prevRemovalCompleted: !!account.removalCompleted,
        prevRemovalCompletedAt: account.removalCompletedAt || null,
      });
      state.undoCount++;
      await persistDecision(account, { removalCompleted: true, removalCompletedAt: Date.now() });
      if (state.pendingRemoval?.usernameKey === account.usernameKey) state.pendingRemoval = null;
      if (!opts.silent) render();
    };
    const skip = () => {
      state.review.skipSet.add(account.usernameKey);
      if (state.pendingRemoval?.usernameKey === account.usernameKey) state.pendingRemoval = null;
      render();
    };
    const openInSnapchat = () => {
      state.pendingRemoval = { usernameKey: account.usernameKey, openedAt: Date.now() };
    };
    // One tap: mark this one removed AND immediately open the next person's
    // profile, so a fast reviewer can just alternate "remove in Snapchat" /
    // "tap this button" without hunting for the Open button each time.
    // window.open must fire synchronously (before any await) or Safari's
    // popup blocker will swallow it, since it needs an active user gesture.
    const removedAndNext = () => {
      const next = remaining[1];
      if (next) window.open(snapchatUrl(next.username), "_blank", "noopener");
      markRemoved();
    };

    // --- "Welcome back" fast path -------------------------------------
    // If the person just switched to Snapchat from this exact card and has
    // now returned, skip straight to a big confirm instead of making them
    // find the button again.
    const backAlready =
      state.pendingRemoval &&
      state.pendingRemoval.usernameKey === account.usernameKey &&
      Date.now() - state.pendingRemoval.openedAt > 700 &&
      document.visibilityState === "visible";

    const cardWrap = el("div", { class: "cardWrap" }, buildCard(account));
    wrap.appendChild(cardWrap);

    if (backAlready) {
      wrap.appendChild(
        el(
          "div",
          { class: "welcomeBackBanner" },
          el("p", null, `Back already? Mark @${esc(account.username)} removed?`),
          el(
            "div",
            { class: "actions-3" },
            el("button", { class: "keep wide", onclick: () => markRemoved() }, "YES, REMOVED ✓"),
            el(
              "button",
              { class: "textBtn", onclick: () => (state.pendingRemoval = null) || render() },
              "Not yet"
            )
          )
        )
      );
    }

    attachSwipe(cardWrap, {
      onKeep: () => markRemoved(),
      onRemove: skip,
      onLater: null,
      labels: { keep: "REMOVED", remove: "SKIP" },
    });

    wrap.appendChild(
      el(
        "div",
        { class: "actions actions-3" },
        el(
          "a",
          { class: "snapBtn wide", href: snapchatUrl(account.username), target: "_blank", rel: "noopener", onclick: openInSnapchat },
          "OPEN IN SNAPCHAT"
        ),
        remaining.length > 1
          ? el("button", { class: "keep wide", onclick: removedAndNext }, "REMOVED ✓ — OPEN NEXT")
          : el("button", { class: "keep wide", onclick: () => markRemoved() }, "REMOVED ✓"),
        el("button", { class: "textBtn", onclick: skip }, "SKIP")
      )
    );
    wrap.appendChild(el("p", { class: "hint" }, "Swipe right once you've removed them in Snapchat, or left to skip for now."));

    return wrap;
  }

  // ---- Later Queue --------------------------------------------------------

  function renderLaterQueue() {
    state.review.filterId = "later_queue";
    return renderReview();
  }

  // ---- Dashboard --------------------------------------------------------

  function renderDashboard() {
    const total = state.accounts.length;
    const c = (d) => state.accounts.filter((a) => a.decision === d).length;
    const keep = c("KEEP"),
      remove = c("REMOVE"),
      later = c("LATER"),
      unreviewed = total - keep - remove - later;
    const reviewedPct = total ? Math.round(((keep + remove + later) / total) * 100) : 0;
    const removalTotal = state.accounts.filter((a) => a.decision === "REMOVE").length;
    const removalDone = state.accounts.filter((a) => a.decision === "REMOVE" && a.removalCompleted).length;

    return el(
      "section",
      { class: "dashboard" },
      el(
        "div",
        { class: "dashHeader" },
        el("div", null, el("h1", null, "SnapClean"), el("p", { class: "muted" }, "Private Snapchat cleanup on your device")),
        el("button", { class: "iconBtn", onclick: () => navigate("#/settings") }, "☰")
      ),
      el(
        "div",
        { class: "statHero" },
        el("div", { class: "bigNumber" }, total.toLocaleString()),
        el("div", { class: "muted" }, "accounts analyzed"),
        el("div", { class: "muted" }, `${reviewedPct}% reviewed`)
      ),
      el(
        "div",
        { class: "statGrid" },
        el("div", { class: "statCard keep" }, el("div", { class: "n" }, keep.toLocaleString()), el("div", null, "Keep")),
        el("div", { class: "statCard remove" }, el("div", { class: "n" }, remove.toLocaleString()), el("div", null, "Remove")),
        el("div", { class: "statCard later" }, el("div", { class: "n" }, later.toLocaleString()), el("div", null, "Later")),
        el("div", { class: "statCard unreviewed" }, el("div", { class: "n" }, unreviewed.toLocaleString()), el("div", null, "Unreviewed"))
      ),
      removalTotal
        ? el("div", { class: "muted removalProgress" }, `${removalDone.toLocaleString()} / ${removalTotal.toLocaleString()} removals completed`)
        : null,
      el(
        "div",
        { class: "menuList" },
        el(
          "button",
          { class: "primary", onclick: () => navigate("#/review/priority_cleanup/highest_priority") },
          "Continue Priority Cleanup"
        ),
        el("button", { onclick: () => navigate("#/removal") }, "Removal Queue"),
        el("button", { onclick: () => navigate("#/later") }, "Later Queue"),
        el("button", { onclick: () => navigate("#/search") }, "Search"),
        el("button", { onclick: () => navigate("#/browse") }, "Filters"),
        el("button", { onclick: () => navigate("#/settings") }, "Settings & Backup")
      ),
      state.lastImport
        ? el(
            "div",
            { class: "muted lastImport" },
            `Last Snapchat data import: ${new Date(state.lastImport.timestamp).toLocaleDateString()}`
          )
        : null
    );
  }

  // ---- Browse / filter picker ---------------------------------------------

  function renderBrowse() {
    const now = Date.now();
    const wrap = el(
      "section",
      { class: "browseView" },
      el(
        "div",
        { class: "toolbar" },
        el("button", { class: "iconBtn", onclick: () => navigate("#/dashboard") }, "←"),
        el("h2", null, "Filters")
      )
    );
    const list = el("div", { class: "filterList" });
    for (const f of Engine.FILTERS) {
      const count = state.accounts.filter((a) => Engine.matchesFilter(a, f.id, now)).length;
      list.appendChild(
        el(
          "button",
          { class: "filterRow", onclick: () => navigate(`#/review/${f.id}/highest_priority`) },
          el("span", null, f.label),
          el("span", { class: "count" }, count.toLocaleString())
        )
      );
    }
    wrap.appendChild(list);
    return wrap;
  }

  // ---- Search -------------------------------------------------------------

  function renderSearch() {
    const wrap = el(
      "section",
      { class: "searchView" },
      el(
        "div",
        { class: "toolbar" },
        el("button", { class: "iconBtn", onclick: () => navigate("#/dashboard") }, "←"),
        el("h2", null, "Search")
      )
    );
    const input = el("input", {
      type: "search",
      class: "searchInput",
      placeholder: "Search username or display name",
      value: state.search.term,
    });
    wrap.appendChild(input);

    const results = el("div", { class: "resultList" });
    wrap.appendChild(results);

    function runSearch() {
      const term = input.value.trim().toLowerCase();
      state.search.term = term;
      results.replaceChildren();
      if (!term) return;
      const matches = state.accounts.filter(
        (a) => a.username.toLowerCase().includes(term) || (a.displayName || "").toLowerCase().includes(term)
      );
      const shown = matches.slice(0, state.search.limit);
      for (const a of shown) {
        results.appendChild(
          el(
            "button",
            { class: "resultRow", onclick: () => navigate(`#/detail/${encodeURIComponent(a.usernameKey)}`) },
            el(
              "div",
              null,
              el("div", { class: "resultName" }, a.displayName || a.username),
              el("div", { class: "resultUser" }, "@" + a.username)
            ),
            el(
              "div",
              { class: "resultMeta" },
              el("span", { class: `pill ${stateBadgeClass(Engine.deriveStateKey(a))}` }, Engine.deriveRelationshipState(a)),
              el("span", null, a.decision || "PENDING"),
              a.decision === "REMOVE" ? el("span", null, a.removalCompleted ? "Removed" : "Not removed") : null
            )
          )
        );
      }
      if (matches.length > shown.length) {
        results.appendChild(
          el(
            "button",
            {
              class: "textBtn",
              onclick: () => {
                state.search.limit += 150;
                runSearch();
              },
            },
            `Show ${Math.min(150, matches.length - shown.length)} more (${matches.length - shown.length} remaining)`
          )
        );
      }
    }

    input.addEventListener("input", () => {
      state.search.limit = 150;
      runSearch();
    });
    runSearch();
    setTimeout(() => input.focus(), 50);
    return wrap;
  }

  // ---- Detail (opened from Search) -----------------------------------------

  function renderDetail(usernameKey) {
    const account = state.byKey.get(decodeURIComponent(usernameKey || ""));
    const wrap = el(
      "section",
      { class: "reviewView" },
      el(
        "div",
        { class: "toolbar" },
        el("button", { class: "iconBtn", onclick: () => history.back() }, "←"),
        el("h2", null, "Account Detail")
      )
    );
    if (!account) {
      wrap.appendChild(el("div", { class: "emptyState" }, el("p", null, "Account not found.")));
      return wrap;
    }
    const cardWrap = el("div", { class: "cardWrap" }, buildCard(account));
    wrap.appendChild(cardWrap);

    const decide = async (decision) => {
      await DB.pushUndo({ type: "decision", usernameKey: account.usernameKey, prevDecision: account.decision || "PENDING" });
      state.undoCount++;
      await persistDecision(account, { decision });
      render();
    };

    wrap.appendChild(
      el(
        "div",
        { class: "actions" },
        el("button", { class: "remove", onclick: () => decide("REMOVE") }, "✕", el("small", null, "REMOVE")),
        el("button", { class: "later", onclick: () => decide("LATER") }, "?", el("small", null, "LATER")),
        el("button", { class: "keep", onclick: () => decide("KEEP") }, "♥", el("small", null, "KEEP"))
      )
    );
    return wrap;
  }

  // ---- Settings / import / backup ------------------------------------------

  function renderSettings() {
    const wrap = el(
      "section",
      { class: "settingsView" },
      el(
        "div",
        { class: "toolbar" },
        el("button", { class: "iconBtn", onclick: () => navigate("#/dashboard") }, "←"),
        el("h2", null, "Settings & Backup")
      ),
      el("p", { class: "privacyNote" }, "Your Snapchat data stays on this device. Nothing is uploaded to a server.")
    );

    const menu = el("div", { class: "menuList" });
    menu.appendChild(el("label", { class: "primary fileBtn" }, "Update Snapchat Data", fileInput()));
    menu.appendChild(el("button", { onclick: exportDecisionsCsv }, "Export Decisions CSV"));
    menu.appendChild(el("button", { onclick: exportBackupJson }, "Export SnapClean Backup"));
    menu.appendChild(el("label", { class: "fileBtn" }, "Restore SnapClean Backup", restoreInput()));
    menu.appendChild(
      el(
        "button",
        {
          class: "danger",
          onclick: async () => {
            if (!confirm("Delete all SnapClean local data? This cannot be undone.")) return;
            await DB.wipeDatabase();
            await loadFromDB();
            navigate("#/dashboard");
          },
        },
        "Reset local data"
      )
    );
    wrap.appendChild(menu);

    if (state.lastImport) {
      wrap.appendChild(
        el(
          "div",
          { class: "importLog" },
          el("h3", null, "Last import"),
          el("p", null, `${esc(state.lastImport.fileName || "Snapchat export")}`),
          el("p", { class: "muted" }, new Date(state.lastImport.timestamp).toLocaleString()),
          el("p", { class: "muted" }, `${state.lastImport.counts?.total ?? state.accounts.length} accounts`)
        )
      );
    }

    return wrap;
  }

  function fileInput() {
    const input = el("input", { type: "file", accept: ".zip,application/zip", class: "hiddenFileInput" });
    input.addEventListener("change", (e) => handleImportFile(e.target.files[0]));
    return input;
  }
  function restoreInput() {
    const input = el("input", { type: "file", accept: ".json,application/json", class: "hiddenFileInput" });
    input.addEventListener("change", (e) => handleRestoreBackup(e.target.files[0]));
    return input;
  }

  function csvCell(v) {
    return `"${String(v ?? "").replaceAll('"', '""')}"`;
  }
  function downloadBlob(content, mime, filename) {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function exportDecisionsCsv() {
    const cols = [
      "username",
      "display_name",
      "relationship_state",
      "relationship_flags",
      "friendship_start",
      "last_interaction",
      "last_authored_at",
      "last_authored_by",
      "cleanup_priority",
      "cleanup_reasons",
      "decision",
      "removal_completed",
      "removal_completed_at",
    ];
    const rows = [cols];
    for (const a of state.accounts) {
      rows.push([
        a.username,
        a.displayName,
        Engine.deriveRelationshipState(a),
        (a.relationshipFlags || []).join(";"),
        a.friendshipStart ? new Date(a.friendshipStart).toISOString() : "",
        a.lastInteraction ? new Date(a.lastInteraction).toISOString() : "",
        a.lastAuthoredAt ? new Date(a.lastAuthoredAt).toISOString() : "",
        a.lastAuthoredBy,
        a.cleanupPriority,
        (a.cleanupReasons || []).map((r) => `${r.label} (+${r.points})`).join("; "),
        a.decision || "PENDING",
        !!a.removalCompleted,
        a.removalCompletedAt ? new Date(a.removalCompletedAt).toISOString() : "",
      ]);
    }
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\n");
    downloadBlob(csv, "text/csv", `snapclean-decisions-${Date.now()}.csv`);
  }

  async function exportBackupJson() {
    const backup = {
      kind: "snapclean-backup",
      version: 1,
      exportedAt: Date.now(),
      lastImport: state.lastImport,
      accounts: state.accounts.map((a) => ({
        usernameKey: a.usernameKey,
        username: a.username,
        displayName: a.displayName,
        decision: a.decision || "PENDING",
        removalCompleted: !!a.removalCompleted,
        removalCompletedAt: a.removalCompletedAt || null,
      })),
    };
    downloadBlob(JSON.stringify(backup, null, 2), "application/json", `snapclean-backup-${Date.now()}.json`);
  }

  async function handleRestoreBackup(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      if (!backup || backup.kind !== "snapclean-backup" || !Array.isArray(backup.accounts)) {
        throw new Error("This file is not a recognized SnapClean backup.");
      }
      let applied = 0;
      for (const rec of backup.accounts) {
        const acc = state.byKey.get(rec.usernameKey);
        if (!acc) continue;
        await persistDecision(acc, {
          decision: rec.decision || "PENDING",
          removalCompleted: !!rec.removalCompleted,
          removalCompletedAt: rec.removalCompletedAt || null,
        });
        applied++;
      }
      alert(`Restored decisions for ${applied} of ${backup.accounts.length} accounts (matched by username).`);
      render();
    } catch (err) {
      alert("Restore failed: " + err.message);
    }
  }

  // ---- Import flow (initial + re-import) ------------------------------------

  function renderImportView() {
    const wrap = el(
      "section",
      { class: "importView" },
      el("h1", null, "SnapClean"),
      el("p", { class: "tagline" }, "Tinder-style cleanup for a huge Snapchat friends list."),
      el(
        "div",
        { class: "panel" },
        el("h2", null, "Import Snapchat My Data"),
        el("p", null, "Your ZIP is parsed on this device. It is never uploaded anywhere."),
        el("label", { class: "primary fileBtn" }, "Choose Snapchat ZIP", fileInput()),
        el("div", { id: "importStatus" })
      ),
      el("p", { class: "privacyNote" }, "Your Snapchat data stays on this device.")
    );
    return wrap;
  }

  function statusPanel(container) {
    const box = el("div", { class: "importProgress" });
    container.querySelector("#importStatus")?.replaceChildren(box);
    return box;
  }

  const STAGE_LABELS = {
    reading: "Reading friend states…",
    friends: "Reading friend states…",
    chats: "Analyzing chats…",
    snaps: "Analyzing Snap history…",
    building: "Building database…",
  };

  function showPersistentError(container, title, message, technical) {
    const box = el(
      "div",
      { class: "errorPanel" },
      el("h3", null, title),
      el("p", null, message),
      technical
        ? el(
            "details",
            null,
            el("summary", null, "Technical details"),
            el("pre", null, typeof technical === "string" ? technical : JSON.stringify(technical, null, 2))
          )
        : null,
      el("button", { class: "primary", onclick: () => render() }, "Try again")
    );
    const target = container.querySelector("#importStatus") || container;
    target.replaceChildren(box);
  }

  async function handleImportFile(file) {
    if (!file) return;
    const container = app.querySelector("#view");
    let statusBox = statusPanel(container);
    const setStage = (stage, detail) => {
      statusBox.textContent = STAGE_LABELS[stage] || stage;
      if (detail && detail.processed) {
        statusBox.textContent += ` (${detail.processed.toLocaleString()}${detail.total ? " / " + detail.total.toLocaleString() : ""})`;
      }
    };

    try {
      setStage("reading");
      const buf = new Uint8Array(await file.arrayBuffer());
      const result = await Parser.parseSnapchatZip(buf, setStage);

      // Merge with existing decisions (data safety: only commit after a
      // fully successful parse; existing DB stays untouched until now).
      const existing = state.byKey;
      const now = Date.now();
      const merged = result.accounts.map((a) => {
        const prior = existing.get(a.usernameKey);
        const base = Object.assign(
          {
            lastChatInteraction: null,
            lastSnapInteraction: null,
            lastAuthoredAt: null,
            lastAuthoredBy: "UNKNOWN",
            lastAuthoredKind: "UNKNOWN",
            decision: "PENDING",
            removalCompleted: false,
            removalCompletedAt: null,
          },
          a
        );
        if (prior) {
          base.decision = prior.decision || "PENDING";
          base.removalCompleted = !!prior.removalCompleted;
          base.removalCompletedAt = prior.removalCompletedAt || null;
        }
        const { score, reasons } = Engine.computeCleanupPriority(base, now);
        base.cleanupPriority = score;
        base.cleanupReasons = reasons;
        base.importVersion = IMPORT_VERSION;
        base.updatedAt = now;
        return base;
      });

      await DB.putAccounts(merged);
      const importMeta = {
        fileName: file.name,
        timestamp: now,
        counts: result.counts,
        warnings: result.warnings,
      };
      await DB.setMeta("lastImport", importMeta);

      await loadFromDB();

      if (result.warnings && result.warnings.length) {
        statusBox = statusPanel(container) || statusBox;
      }
      navigate("#/dashboard");
      if (result.warnings && result.warnings.length) {
        console.warn("SnapClean import warnings:", result.warnings);
      }
    } catch (err) {
      const isParseError = Parser.SnapCleanParseError && err instanceof Parser.SnapCleanParseError;
      showPersistentError(
        container,
        "Import failed",
        isParseError ? err.message : "Something went wrong while reading this file. " + err.message,
        err.stack || String(err)
      );
    }
  }

  // ---- boot ------------------------------------------------------------------

  async function boot() {
    try {
      await loadFromDB();
    } catch (err) {
      app.querySelector("#view").replaceChildren(
        el(
          "div",
          { class: "errorPanel" },
          el("h3", null, "Storage unavailable"),
          el(
            "p",
            null,
            "SnapClean could not open its local database. Private Browsing mode and very low device storage are common causes."
          ),
          el("pre", null, String(err && err.message))
        )
      );
      return;
    }
    render();
  }

  document.addEventListener("DOMContentLoaded", boot);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {
        /* offline shell is a progressive enhancement, not required */
      });
    });
  }
})();
