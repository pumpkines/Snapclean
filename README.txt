SnapClean Web v0.1

WHAT THIS IS
An iPhone-first PWA. The Snapchat My Data ZIP is parsed in the browser and stored locally on the device.

FEATURES
- Import Snapchat My Data ZIP directly from iPhone Files
- Priority cleanup and relationship/activity filters
- Tinder-style Remove / Later / Keep decisions
- View in Snapchat button using Snapchat's official /add/USERNAME URL
- Decisions persist locally
- Re-import a newer Snapchat export without losing decisions
- Export decisions CSV

IMPORTANT
SnapClean does NOT call Snapchat private APIs and does not programmatically remove friends. "Remove" builds your removal queue. Use "View in Snapchat" to open the official Snapchat surface and perform friendship changes there.

RUN LOCALLY ON A COMPUTER
Because service workers/PWAs need HTTP(S), don't double-click index.html.
Example:
  python -m http.server 8080
Then open http://localhost:8080

IPHONE INSTALL
Host this folder on any HTTPS static host (GitHub Pages, Cloudflare Pages, Netlify, etc.).
Open the HTTPS address in Safari.
Share -> Add to Home Screen -> turn on Open as Web App -> Add.

FIRST LOAD
The ZIP parser uses fflate from jsDelivr. Open SnapClean once while online before importing.
