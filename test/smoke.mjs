// Smoke test: runs the actual app.js/db.js/engine.js/parser.js inside jsdom
// with fake-indexeddb, simulating a real browser session end-to-end:
// boot with empty DB -> import view -> import fixture ZIP -> dashboard ->
// review card renders -> decide Keep -> Removal Queue -> Search.
//
// Run from repo root: node test/smoke.mjs

import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "fake-indexeddb/auto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = `${__dirname}/..`;

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error("FAIL:", msg);
  } else {
    console.log("ok  :", msg);
  }
}
function assertEqual(actual, expected, msg) {
  assert(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

async function main() {
  const html = readFileSync(`${root}/index.html`, "utf8");
  // SnapClean is iPhone-first, and its Removal Queue copy/behavior branches
  // on that (opening a Snapchat link on iOS hands off to the native app,
  // where removal actually works; elsewhere it doesn't). Simulate an iPhone
  // UA for the main flow so this exercises the primary target platform.
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    resources: {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    },
  });
  const { window } = dom;

  // fake-indexeddb/auto already patched global.indexedDB; mirror it onto window.
  window.indexedDB = globalThis.indexedDB;
  window.IDBKeyRange = globalThis.IDBKeyRange;

  // jsdom doesn't implement Pointer Capture, scrollTo, or window.open; stub them.
  window.HTMLElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.scrollTo = () => {};
  window.open = () => ({ closed: false });

  const loadScript = (path) => {
    const code = readFileSync(`${root}/${path}`, "utf8");
    window.eval(code);
  };

  loadScript("vendor/fflate.js");
  loadScript("js/engine.js");
  loadScript("js/parser.js");
  loadScript("js/db.js");

  assert(!!window.SnapCleanEngine, "engine.js loaded into window");
  assert(!!window.SnapCleanParser, "parser.js loaded into window");
  assert(!!window.SnapCleanDB, "db.js loaded into window");

  // app.js self-boots on DOMContentLoaded and registers a service worker via
  // navigator.serviceWorker, which jsdom doesn't implement — stub it first.
  window.navigator.serviceWorker = { register: () => Promise.resolve() };

  loadScript("js/app.js");
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await new Promise((r) => setTimeout(r, 50));

  const view = window.document.getElementById("view");
  assert(!!view, "#view container exists");
  assert(/Import Snapchat My Data/.test(view.textContent), "empty DB shows the import view");

  // --- simulate choosing the fixture ZIP -------------------------------
  const zipBytes = readFileSync(`${root}/test/fixtures/snapchat_my_data_test.zip`);
  const fakeFile = {
    name: "snapchat_my_data_test.zip",
    arrayBuffer: async () => zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength),
  };

  const fileInput = view.querySelector('input[type="file"][accept*="zip"]');
  assert(!!fileInput, "import file input is present");

  // app.js wires file input via addEventListener("change", handler); invoke
  // the handler indirectly by dispatching a change event after monkeypatching
  // `files` isn't possible in jsdom, so we call the same code path directly
  // through the DOM event with a stubbed target.
  const changeEvent = new window.Event("change");
  Object.defineProperty(changeEvent, "target", { value: { files: [fakeFile] } });
  fileInput.dispatchEvent(changeEvent);

  // Import is async; poll until the dashboard shows up (or timeout).
  let waited = 0;
  while (waited < 4000) {
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
    if (/accounts analyzed/.test(view.textContent)) break;
  }
  assert(/accounts analyzed/.test(view.textContent), "dashboard renders after import (stats visible)");
  assert(!/Import failed/.test(view.textContent), "no persistent import error shown");

  // --- navigate to Priority Cleanup review ------------------------------
  window.location.hash = "#/review/priority_cleanup/highest_priority";
  await new Promise((r) => setTimeout(r, 50));
  assert(!!view.querySelector("#reviewCard"), "review card renders for priority_cleanup queue");
  assert(!!view.querySelector(".snapBtn"), "View in Snapchat button renders on the card");

  const keepBtn = [...view.querySelectorAll(".actions button")].find((b) => /KEEP/.test(b.textContent));
  assert(!!keepBtn, "Keep button present");
  const cardBefore = view.querySelector(".displayName")?.textContent;
  keepBtn.click();
  await new Promise((r) => setTimeout(r, 250));
  const cardAfter = view.querySelector(".displayName")?.textContent;
  assert(cardBefore !== cardAfter || !view.querySelector("#reviewCard"), "queue advances to a new card (or completes) after a decision");

  // --- Removal Queue view -------------------------------------------------
  window.location.hash = "#/removal";
  await new Promise((r) => setTimeout(r, 50));
  assert(/Removal Queue/.test(view.textContent), "removal queue view renders");

  // First move at least one account into the Remove decision so the queue is
  // non-empty, then verify the streamlined removal controls render.
  window.location.hash = "#/browse";
  await new Promise((r) => setTimeout(r, 50));
  window.location.hash = "#/review/priority_cleanup/highest_priority";
  await new Promise((r) => setTimeout(r, 50));
  // Move several accounts to REMOVE so batch mode (which needs >1 remaining)
  // has something to work with.
  for (let i = 0; i < 4; i++) {
    const btn = [...view.querySelectorAll(".actions button")].find((b) => /REMOVE/.test(b.textContent));
    if (!btn) break;
    btn.click();
    await new Promise((r) => setTimeout(r, 250));
  }

  window.location.hash = "#/removal";
  await new Promise((r) => setTimeout(r, 50));
  assert(/OPEN IN SNAPCHAT/.test(view.textContent), "on iOS (simulated UA), the removal button reads 'OPEN IN SNAPCHAT' since the deep link hands off to the native app");
  assert(!/doesn't reliably support removing/.test(view.textContent), "on iOS, the 'Snapchat web can't remove friends' caveat is not shown (the native-app handoff makes it moot)");
  if (/OPEN IN SNAPCHAT/.test(view.textContent)) {
    const openLink = view.querySelector(".snapBtn.wide");
    assert(!!openLink, "Removal Queue 'Open in Snapchat' link renders");
    openLink.dispatchEvent(new window.Event("click"));

    // Simulate returning to the tab after >700ms and re-rendering (the app
    // listens for visibilitychange; jsdom reports visibilityState via a
    // getter we can't easily flip, so re-invoke render() directly here to
    // confirm the "welcome back" fast-path logic itself doesn't throw).
    await new Promise((r) => setTimeout(r, 800));
    window.dispatchEvent(new window.Event("hashchange"));
    await new Promise((r) => setTimeout(r, 50));
    assert(!/undefined/.test(view.textContent), "removal queue re-renders cleanly after Open in Snapchat");

    const removedBtn = [...view.querySelectorAll("button")].find((b) => /REMOVED/.test(b.textContent));
    assert(!!removedBtn, "a REMOVED confirm control is present (either the combined action or the welcome-back banner)");
  }

  // --- The Bitmoji/Public Profile embed feature was removed: Snapchat's
  // Public Profile embed widget only works for creator/subscribe accounts,
  // not an ordinary friend's regular add-friend page, so it produced
  // "Oops something went wrong" for real friends. Regression guard: it
  // should not reappear anywhere in the UI.
  window.location.hash = "#/review/priority_cleanup/highest_priority";
  await new Promise((r) => setTimeout(r, 50));
  assert(!view.querySelector(".profileToggle"), "the removed Bitmoji/Public Profile embed toggle does not reappear on review cards");
  assert(!view.querySelector(".snapchat-embed"), "no Snapchat embed blockquote is ever injected");
  assert(!window.document.querySelector("script[data-snap-embed-loader]"), "the Snapchat embed.js loader script is never injected");
  window.location.hash = "#/settings";
  await new Promise((r) => setTimeout(r, 50));
  assert(!/Auto-show Bitmoji/.test(view.textContent), "Settings no longer offers the removed auto-show profile preview toggle");

  // --- keyboard shortcuts -------------------------------------------------
  window.location.hash = "#/review/priority_cleanup/highest_priority";
  await new Promise((r) => setTimeout(r, 50));
  if (view.querySelector("#reviewCard")) {
    const nameBefore = view.querySelector(".displayName")?.textContent;
    window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    const nameAfter = view.querySelector(".displayName")?.textContent;
    assert(nameBefore !== nameAfter || !view.querySelector("#reviewCard"), "ArrowRight keyboard shortcut advances the review queue (Keep)");
  }

  // --- "REMOVED \u2713 \u2014 OPEN NEXT" combined action -----------------------------
  // Regression guard: this must use a real anchor .click(), and must never
  // call window.open() more than once per press.
  {
    let anchorClicks = 0;
    const originalAnchorClick = window.HTMLAnchorElement.prototype.click;
    window.HTMLAnchorElement.prototype.click = function (...args) {
      if (this.target === "_blank") anchorClicks++;
      return originalAnchorClick.apply(this, args);
    };
    window.location.hash = "#/removal";
    await new Promise((r) => setTimeout(r, 50));
    const combinedBtn = [...view.querySelectorAll("button")].find((b) => /OPEN NEXT/.test(b.textContent));
    assert(!!combinedBtn, "'REMOVED \u2713 \u2014 OPEN NEXT' combined button renders when multiple accounts remain");
    if (combinedBtn) {
      const before = anchorClicks;
      combinedBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      assertEqual(anchorClicks, before + 1, "pressing 'REMOVED \u2713 \u2014 OPEN NEXT' opens the next profile via exactly one real anchor click");
    }
    window.HTMLAnchorElement.prototype.click = originalAnchorClick;
  }

  // --- Batch removal mode -------------------------------------------------
  // Regression guard for the real bug report: starting a batch must NOT call
  // window.open() in a loop (that's what produced blank/blocked tabs across
  // browsers). Track calls to catch any regression.
  let windowOpenCalls = 0;
  const originalWindowOpen = window.open;
  window.open = (...args) => {
    windowOpenCalls++;
    return originalWindowOpen(...args);
  };

  window.location.hash = "#/removal";
  await new Promise((r) => setTimeout(r, 50));
  const batchBtn = view.querySelector(".batchLaunchBtn");
  assert(!!batchBtn, "batch launcher button renders when 2+ accounts are queued for removal");
  if (batchBtn) {
    const callsBefore = windowOpenCalls;
    batchBtn.click();
    await new Promise((r) => setTimeout(r, 50));
    assertEqual(windowOpenCalls, callsBefore, "starting a batch must not call window.open() at all (real link clicks only, per row)");
    assert(/Batch/.test(view.textContent), "batch removal mode renders after starting a batch");
    const openLink = view.querySelector(".batchRowOpen");
    assert(!!openLink && openLink.tagName === "A" && openLink.getAttribute("href")?.includes("snapchat.com"), "each batch row is a real <a> link to the profile (reliable across browsers, unlike window.open)");
    const checkbox = view.querySelector(".batchRow input[type=checkbox]");
    assert(!!checkbox, "batch checklist renders a checkbox per opened profile");
    if (checkbox) {
      checkbox.checked = true;
      checkbox.dispatchEvent(new window.Event("change"));
      await new Promise((r) => setTimeout(r, 100));
      assert(/done/.test(view.querySelector(".batchRow")?.className || ""), "checking a batch row marks it done and greys it out");
    }
    const doneBtn = [...view.querySelectorAll("button")].find((b) => /Done with this batch/.test(b.textContent));
    assert(!!doneBtn, "'Done with this batch' control is present");
    if (doneBtn) {
      doneBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      assert(!view.querySelector(".batchList"), "leaving batch mode returns to the normal Removal Queue view");
    }
  }
  window.open = originalWindowOpen;

  // --- Search view ----------------------------------------------------
  window.location.hash = "#/search";
  await new Promise((r) => setTimeout(r, 50));
  const searchInput = view.querySelector(".searchInput");
  assert(!!searchInput, "search input renders");
  searchInput.value = "alice";
  searchInput.dispatchEvent(new window.Event("input"));
  await new Promise((r) => setTimeout(r, 50));
  assert(/alice_current/.test(view.textContent), "search finds alice_current");

  // --- Settings / export -------------------------------------------------
  window.location.hash = "#/settings";
  await new Promise((r) => setTimeout(r, 50));
  assert(/Export Decisions CSV/.test(view.textContent), "settings view renders export controls");
  const forceUpdateBtn = [...view.querySelectorAll("button")].find((b) => /Force update SnapClean/.test(b.textContent));
  assert(!!forceUpdateBtn, "Settings offers a 'Force update SnapClean' control to clear stale cached app code");

  console.log(`\n${failures === 0 ? "SMOKE TEST PASSED" : "SMOKE TEST FAILED"} (${failures} failure(s))`);
  if (failures > 0) process.exit(1);
}

// --- Secondary check: on a non-iOS device, the Removal Queue must clearly
// state that Snapchat's web app can't remove friends, and the primary
// button must not claim it can. This is a lighter-weight standalone check
// (fresh boot + import + one navigation) rather than the full flow above.
async function desktopPlatformCheck() {
  const html = readFileSync(`${root}/index.html`, "utf8");
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    resources: {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    },
  });
  const { window } = dom;
  const fakeIDB = await import("fake-indexeddb");
  window.indexedDB = new fakeIDB.IDBFactory();
  window.IDBKeyRange = fakeIDB.IDBKeyRange;
  window.HTMLElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.scrollTo = () => {};
  window.open = () => ({ closed: false });
  window.navigator.serviceWorker = { register: () => Promise.resolve() };

  const loadScript = (path) => window.eval(readFileSync(`${root}/${path}`, "utf8"));
  loadScript("vendor/fflate.js");
  loadScript("js/engine.js");
  loadScript("js/parser.js");
  loadScript("js/db.js");
  loadScript("js/app.js");
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await new Promise((r) => setTimeout(r, 50));

  const view = window.document.getElementById("view");
  const zipBytes = readFileSync(`${root}/test/fixtures/snapchat_my_data_test.zip`);
  const fakeFile = {
    name: "snapchat_my_data_test.zip",
    arrayBuffer: async () => zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength),
  };
  const fileInput = view.querySelector('input[type="file"][accept*="zip"]');
  const changeEvent = new window.Event("change");
  Object.defineProperty(changeEvent, "target", { value: { files: [fakeFile] } });
  fileInput.dispatchEvent(changeEvent);
  let waited = 0;
  while (waited < 4000) {
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
    if (/accounts analyzed/.test(view.textContent)) break;
  }

  window.location.hash = "#/review/priority_cleanup/highest_priority";
  await new Promise((r) => setTimeout(r, 50));
  for (let i = 0; i < 2; i++) {
    const btn = [...view.querySelectorAll(".actions button")].find((b) => /REMOVE/.test(b.textContent));
    if (!btn) break;
    btn.click();
    await new Promise((r) => setTimeout(r, 250));
  }

  window.location.hash = "#/removal";
  await new Promise((r) => setTimeout(r, 50));
  assert(/doesn't reliably support removing/.test(view.textContent), "on desktop, the Removal Queue shows the 'Snapchat web can't remove friends' caveat");
  assert(/VIEW PROFILE/.test(view.textContent), "on desktop, the primary action reads 'VIEW PROFILE' rather than implying removal happens there");
  assert(!/^OPEN IN SNAPCHAT$/m.test(view.querySelector(".snapBtn.wide")?.textContent || ""), "the desktop button text does not claim 'OPEN IN SNAPCHAT'");
}

main()
  .then(desktopPlatformCheck)
  .then(() => {
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("Smoke test crashed:", err);
    process.exit(1);
  });
