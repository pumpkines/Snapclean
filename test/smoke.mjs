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

async function main() {
  const html = readFileSync(`${root}/index.html`, "utf8");
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
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
  for (let i = 0; i < 3; i++) {
    const btn = [...view.querySelectorAll(".actions button")].find((b) => /REMOVE/.test(b.textContent));
    if (!btn) break;
    btn.click();
    await new Promise((r) => setTimeout(r, 250));
  }

  window.location.hash = "#/removal";
  await new Promise((r) => setTimeout(r, 50));
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

  // --- Bitmoji / Public Profile preview: now auto-shown by default -------
  window.location.hash = "#/review/priority_cleanup/highest_priority";
  await new Promise((r) => setTimeout(r, 50));
  const profileToggle = view.querySelector(".profileToggle");
  assert(!!profileToggle, "Bitmoji/Public Profile toggle renders on the review card");
  const autoContainer = view.querySelector(".profilePreview");
  assert(!!autoContainer && !autoContainer.classList.contains("hidden"), "profile preview is auto-expanded by default (no tap needed)");
  assert(!!autoContainer.querySelector(".snapchat-embed"), "official Snapchat embed blockquote is auto-injected");
  assert(!!window.document.querySelector('script[data-snap-embed-loader]'), "Snapchat's embed.js loader script is injected to trigger rendering");
  assert(/Hide Preview/.test(profileToggle.textContent), "toggle reads 'Hide Preview' when auto-shown");

  // Toggling it off should collapse the container.
  profileToggle.click();
  await new Promise((r) => setTimeout(r, 20));
  assert(autoContainer.classList.contains("hidden"), "tapping the toggle hides the preview");

  // --- Settings: auto-show preference toggle ------------------------------
  window.location.hash = "#/settings";
  await new Promise((r) => setTimeout(r, 50));
  const autoShowSettingBtn = [...view.querySelectorAll("button")].find((b) => /Auto-show Bitmoji/.test(b.textContent));
  assert(!!autoShowSettingBtn, "Settings has an auto-show profile preview toggle");
  assert(/On/.test(autoShowSettingBtn.textContent), "auto-show defaults to On");
  autoShowSettingBtn.click();
  await new Promise((r) => setTimeout(r, 50));
  const autoShowSettingBtnAfter = [...view.querySelectorAll("button")].find((b) => /Auto-show Bitmoji/.test(b.textContent));
  assert(!!autoShowSettingBtnAfter && /Off/.test(autoShowSettingBtnAfter.textContent), "toggling the setting flips it to Off");
  window.location.hash = "#/review/priority_cleanup/highest_priority";
  await new Promise((r) => setTimeout(r, 50));
  const containerAfterOff = view.querySelector(".profilePreview");
  assert(!!containerAfterOff && containerAfterOff.classList.contains("hidden"), "with auto-show Off, new cards render collapsed by default");

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

  // --- Batch removal mode -------------------------------------------------
  window.location.hash = "#/removal";
  await new Promise((r) => setTimeout(r, 50));
  const batchBtn = view.querySelector(".batchLaunchBtn");
  if (batchBtn) {
    batchBtn.click();
    await new Promise((r) => setTimeout(r, 50));
    assert(/Batch/.test(view.textContent), "batch removal mode renders after 'Open Next N'");
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

  console.log(`\n${failures === 0 ? "SMOKE TEST PASSED" : "SMOKE TEST FAILED"} (${failures} failure(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
