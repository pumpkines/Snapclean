# SnapClean

**Tinder for cleaning up your Snapchat friends list.**

SnapClean is an iPhone-first Progressive Web App (PWA) that turns cleaning up
a very large Snapchat friends list (thousands of accounts) into a fast,
one-person-at-a-time review workflow. It reads your official **Snapchat "My
Data" export**, analyzes it entirely on your device, prioritizes likely
cleanup candidates, and lets you swipe or tap **Keep / Remove / Later** for
each account. Actual friendship changes always happen inside the official
Snapchat app — SnapClean never logs into Snapchat, never calls private APIs,
and never removes anyone automatically.

```
Snapchat My Data ZIP
  → local parser (runs in your browser)
  → IndexedDB (on this device only)
  → relationship/activity analysis + cleanup priority engine
  → Tinder-style review
  → Keep / Remove / Later
  → View in Snapchat when you need to check who someone is
  → dedicated Removal Queue
  → you remove them in Snapchat
  → SnapClean tracks that it's done
```

## Privacy — read this first

- **Your Snapchat data stays on this device.** The ZIP is parsed with
  JavaScript running in your own browser. It is never uploaded anywhere.
- SnapClean does **not** ask for your Snapchat username/password.
- SnapClean does **not** log into Snapchat, call undocumented Snapchat APIs,
  or scrape authenticated Snapchat pages.
- SnapClean does **not** automatically remove friends. "Remove" is a
  decision that adds someone to your local Removal Queue; you perform the
  actual removal yourself, inside the official Snapchat app.
- All data (parsed accounts, your decisions, import history, undo stack)
  lives in this browser's **IndexedDB**. Nothing is sent to a server. The
  GitHub Pages host serves only static application files.
- **Never commit a Snapchat "My Data" ZIP to this repository.** `.gitignore`
  blocks common filenames, but double-check before you `git add`.

## Getting your Snapchat data

1. In Snapchat: **Settings → My Data → Submit Request**.
2. Choose the **HTML** format (not JSON).
3. Wait for Snapchat's email, then download the ZIP to your iPhone (Files
   app) or computer.
4. Do not unzip it — SnapClean reads the ZIP directly.

## Using SnapClean

1. Open SnapClean in Safari (or your installed Home Screen app).
2. **Import Snapchat My Data** → choose the ZIP.
3. Watch the import progress (reading friend states, chats, Snap history,
   building the database).
4. From the dashboard: **Continue Priority Cleanup** to start reviewing.
5. For each account: swipe or tap **Remove / Later / Keep**. Tap
   **View in Snapchat** any time you don't recognize someone — it opens
   their real profile in the Snapchat app, and returns you to the exact
   same card when you switch back.
6. When you're ready to actually clean up: open **Removal Queue** from the
   dashboard. For each entry, open their profile and remove them, then tap
   **Removed ✓** back in SnapClean.

   **Important: removing a friend only works in Snapchat's mobile app.**
   Snapchat's web app doesn't reliably support it (the "Remove Friend"
   option is missing or inconsistent there). On iPhone, SnapClean's links
   hand off to the installed Snapchat app via Apple's universal-link
   system, landing you exactly where removal works — so on your iPhone
   this is seamless. On a computer, the same link only opens a web page
   that can show you who someone is; it can't remove them. SnapClean
   detects this and adjusts automatically: the button reads **"Open in
   Snapchat"** on iPhone and **"View Profile"** on other platforms, with
   an on-screen note on desktop reminding you the actual removal needs
   your phone.

   A few things make this loop faster for a big list:
   - **Swipe right** on the card once you've removed them, or **swipe
     left** to skip for now — same gesture as review.
   - Tapping the profile link and then switching back to SnapClean shows
     a **"Back already? Mark removed?"** confirm automatically, so you
     don't have to hunt for the button.
   - **REMOVED ✓ — OPEN NEXT** marks the current account done and opens
     the *next* person's profile in one tap.
   - **Start a batch of 3 / 5 / 10** lines up several accounts as a
     checklist, each with its own **Open** link (a real per-row link
     click, not an automatic pop-up burst — browsers only reliably allow
     one new tab per click, which is exactly why this is per-row rather
     than automatic). On desktop this is best used to double-check who
     several people are at once before doing the actual removals on your
     phone; on iPhone it's a genuinely faster way to work through a big
     batch.
   - Keyboard shortcuts on a computer: **O** opens the profile, **Enter**/
     **R** marks removed, **S** skips. In review: **←** Remove, **→**
     Keep, **↑** Later, **Z** Undo.
   - If you don't remember who someone is, tap **View in Snapchat** — that
     opens their real profile. (An earlier version tried to preview
     Bitmojis inline using Snapchat's Public Profile embed widget; that
     widget is actually for creator/subscribe accounts, not an ordinary
     friend's regular profile, so it failed for real friends. It's been
     removed rather than left half-working — see below.)
7. Got a newer Snapchat export later? **Settings → Update Snapchat Data.**
   Your existing Keep/Remove/Later decisions and removal-completed status
   are preserved; only the relationship/activity metadata is refreshed.

## Relationship states — what SnapClean will and won't claim

Snapchat's export can place a username in more than one historical
category (e.g. a sent request that never became a friendship, or someone
who is a friend today but was previously in your deleted-friends history).
SnapClean stores every flag it finds and derives a displayed state without
asserting facts the export can't prove:

| Flags present | Displayed state |
|---|---|
| `CURRENT_FRIEND` | Current Friend |
| `DELETED_FRIEND`, no `CURRENT_FRIEND` | Former Friend • Not Current |
| `SENT_REQUEST`, no `CURRENT_FRIEND`/`DELETED_FRIEND` | No Recorded Friendship After Sent Request |
| `PENDING_REQUEST`, no `CURRENT_FRIEND` | Pending Request |

SnapClean never says "they rejected you" or "they unadded you" — the
export can't distinguish that from an expired request, a cancellation, or
another historical state. It also never claims someone "left you on open";
the safest supported signal is **"You sent last • no later recorded
response."**

## Cleanup priority engine

Every account gets an explainable 0–100 score plus a list of point-scoring
reasons (e.g. *Former friend +40, 2+ years inactive +30, You sent last
+12*). The scoring logic lives entirely in [`js/engine.js`](js/engine.js)
as a small set of pure, readable functions — tune `computeCleanupPriority`
there if you want to change the weighting.

## Architecture

| File | Responsibility |
|---|---|
| `index.html` / `styles.css` | App shell, dark premium UI, safe-area layout |
| `js/parser.js` | Turns the ZIP into account records. Deliberately **DOM-free** (regex-based HTML extraction, no `DOMParser`) so it's portable and never touches the network. |
| `js/engine.js` | Pure logic: relationship-state derivation, priority scoring, filters, sorting. No DOM, no storage — easy to unit test. |
| `js/db.js` | IndexedDB persistence: `accounts` store (one record per account, indexed on decision/priority/lastInteraction/removalCompleted/flags) and `meta` store (settings, import log, undo stack, review position). Only the affected record is ever rewritten on a decision. |
| `js/app.js` | UI controller: hash-based router, dashboard, Tinder-style review with swipe gestures, Removal Queue, Later Queue, Search, Settings/backup. |
| `sw.js` / `manifest.webmanifest` | Installable, offline-capable PWA shell. |
| `vendor/fflate.js` | Vendored ZIP library (no CDN dependency, so it also works offline once installed). |

### Data model

Each account record (see `js/parser.js` / `js/db.js`) roughly matches the
spec's data model: `username`, `usernameKey`, `displayName`,
`relationshipFlags[]`, `friendshipStart`, `requestDate`, `lastInteraction`,
`lastChatInteraction`, `lastSnapInteraction`, `chatHistoryExists`,
`snapHistoryExists`, `lastAuthoredAt`, `lastAuthoredBy`
(`SELF`/`OTHER`/`UNKNOWN`), `lastAuthoredKind` (`CHAT`/`SNAP`/`UNKNOWN`),
`source`, `cleanupPriority`, `cleanupReasons[]`, `decision`
(`PENDING`/`KEEP`/`REMOVE`/`LATER`), `removalCompleted`,
`removalCompletedAt`, `importVersion`, `updatedAt`. Unknown values are
`null` — nothing is fabricated.

### Known parsing limitations

Snapchat's exported HTML structure isn't publicly specified and can vary
by app version. The parser was built defensively against the documented
shape (`html/friends.html` section tables, `html/chat_history.html` /
`html/snap_history.html` index pages linking to per-friend subpages) and
degrades gracefully — a missing or reshaped section produces a warning
rather than a crash. If your real export's chat/Snap subpage format differs
enough that authorship or timestamps aren't detected, `lastAuthoredBy`
correctly falls back to `UNKNOWN` rather than guessing. If you hit a
real-world export SnapClean doesn't parse well, the fix is entirely
contained in `js/parser.js`.

**Verify your own import**: Settings → Last import → **Import
diagnostics** shows exactly which section headings SnapClean found in
your export, what relationship flag each one was matched to, how many
rows it produced, and a per-flag total (Current Friends: N, Pending: N,
etc.), plus any parse warnings. If a category looks wrong — e.g. 0
Current Friends when you actually have friends — that table will show you
which heading text wasn't recognized, which is usually enough to fix
directly in `js/parser.js`'s `HEADING_FLAG_PATTERNS`. (One real example:
an earlier version required the "Friends" heading to match *exactly*,
which silently broke on exports that render it with a count like
`"Friends (4,528)"` — every current friend was then left unlabeled.
That specific case is fixed and covered by a regression test in
`test/run-tests.mjs`, but the diagnostics panel exists so any *other*
heading-format surprise is visible immediately instead of silently
mislabeling accounts.)

## Local development

No build step is required to run the app — it's static files.

```bash
npm run serve      # python3 -m http.server 8080, then open http://localhost:8080
```

(Service workers require `http://localhost` or HTTPS — don't just
double-click `index.html`.)

### Tests

The parser and scoring engine are pure enough to unit test in Node against
a synthetic fixture export (no real/private Snapchat data required):

```bash
npm install   # pulls in fflate/jsdom/fake-indexeddb as dev dependencies for the test scripts only
npm test      # pure logic + parser unit tests (test/run-tests.mjs)
npm run smoke # full end-to-end smoke test: boots the real app in jsdom, imports
              # the fixture ZIP, and clicks through dashboard/review/removal
              # (including the fast-path controls)/search/the profile-preview toggle
```

`test/build-fixtures.mjs` generates a small synthetic "My Data" export
covering: current friend, former friend, sent-request-only (never
friended), pending request, current friend with no chat/Snap history,
chat-only vs. Snap-only history, 6-month/1-year/2-year inactivity buckets,
SELF vs. OTHER last-sender attribution, STATUS-only rows that must be
ignored for authorship, missing/unparseable dates, and a duplicate
username appearing in two relationship categories at once.
`test/run-tests.mjs` asserts relationship-state derivation, priority
scoring/ordering, every filter, sorting, and the typed error thrown when
`friends.html` is missing.

## Deployment (GitHub Pages)

This app is fully static — no backend, no build step.

1. Push to `pumpkines/Snapclean`.
2. Repo **Settings → Pages → Deploy from a branch → `main` / `/ (root)`**.
3. Open the published HTTPS URL in Safari on iPhone.
4. **Share → Add to Home Screen → Open as Web App → Add.**

## What SnapClean is not

- Not a Snapchat client. It doesn't show your live feed, stories, or chats.
- Not a bot. It cannot and will not remove friends for you.
- Not a data-broker tool. Your export never leaves this device.

## A feature that was removed: inline Bitmoji preview

An earlier version tried to preview each account's Bitmoji directly on the
card using Snapchat's officially documented [Public Profile web embed
widget](https://developers.snap.com/api/snapchat-for-web/social-plugins/embedding-web-content).
That was a mistake in how the feature was applied, not just a wrong URL:
Snap's Public Profile embeds are built for **creator/subscribe accounts**
(brands and creators who've opted into Snapchat's Public Profile feature,
with a Subscribe button) — not for an ordinary friend's regular add-friend
page. Most real friends aren't public-profile creator accounts, so there
was nothing valid for the widget to embed, and it surfaced Snapchat's own
"Oops something went wrong" error instead of a preview. It's been removed
outright rather than left half-working. **View in Snapchat** (which opens
the real profile — reliable, since it's a normal link, not an embed) is
the way to check who someone is.

## Why SnapClean won't automate the removal itself

This comes up, so it's worth stating plainly: SnapClean will never log into
Snapchat, drive the Snapchat app/web client on your behalf, or call a
private/undocumented endpoint to perform the actual "remove friend" action
— not as a batch script, not as a per-swipe "overlay" that fires
automatically, not in any form. This isn't a technical limitation; it's a
deliberate boundary, for reasons that don't go away just because it's your
own account:

- Snapchat's Terms of Service prohibit automated/bot access to accounts.
  Software that logs in and performs bulk actions is exactly what their
  anti-abuse systems are built to catch — the realistic outcome is your
  account getting flagged or locked, not a clean bulk-unfriend.
- There's no official API for third-party friend management, so doing this
  at all would mean scraping session credentials or driving private,
  undocumented internals — fragile today and something Snapchat could
  break (or detect) at any time.
- Removing a friend isn't even reliably possible from Snapchat's *own* web
  app — it's a mobile-app-only action. Any automation would have to drive
  the actual native app (through OS-level accessibility/automation APIs,
  which is its own can of worms) rather than a simple web request.
- It's also one of the boundaries this project started with — no
  credentials stored, nothing that could get an account banned, nothing
  that requires trusting a third-party server with your session — and it
  stays that way regardless of how the request for it is phrased.

What SnapClean does instead is make the *manual* loop as fast as it can be
without crossing that line — see the removal-queue tips above (swipe
gestures, batch tab-opening, keyboard shortcuts, the "welcome back" auto
prompt). Every one of those still ends with you clicking "Remove Friend"
inside Snapchat's own interface.

