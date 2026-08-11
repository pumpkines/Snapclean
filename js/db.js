// db.js — IndexedDB persistence layer for SnapClean.
// All Snapchat-derived data lives ONLY in this browser's IndexedDB. Nothing here
// ever makes a network request; this module only talks to indexedDB.
//
// Object stores:
//   accounts  (keyPath: usernameKey) — one record per Snapchat account
//   meta      (keyPath: key)         — settings, import log, review/undo state
//
// Exposed as the global `SnapCleanDB` (no bundler, so this stays a plain script).

(function (global) {
  "use strict";

  const DB_NAME = "snapclean";
  const DB_VERSION = 1;
  const ACCOUNTS_STORE = "accounts";
  const META_STORE = "meta";

  /** @type {IDBDatabase|null} */
  let dbInstance = null;
  /** @type {Promise<IDBDatabase>|null} */
  let openPromise = null;

  function openDB() {
    if (dbInstance) return Promise.resolve(dbInstance);
    if (openPromise) return openPromise;

    openPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in global)) {
        reject(new Error("STORAGE_UNAVAILABLE: This browser does not support IndexedDB."));
        return;
      }

      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = req.result;

        if (!db.objectStoreNames.contains(ACCOUNTS_STORE)) {
          const store = db.createObjectStore(ACCOUNTS_STORE, { keyPath: "usernameKey" });
          store.createIndex("decision", "decision", { unique: false });
          store.createIndex("cleanupPriority", "cleanupPriority", { unique: false });
          store.createIndex("lastInteraction", "lastInteraction", { unique: false });
          store.createIndex("removalCompleted", "removalCompleted", { unique: false });
          store.createIndex("friendshipStart", "friendshipStart", { unique: false });
          store.createIndex("updatedAt", "updatedAt", { unique: false });
          store.createIndex("relationshipFlags", "relationshipFlags", {
            unique: false,
            multiEntry: true,
          });
        }

        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "key" });
        }
      };

      req.onsuccess = () => {
        dbInstance = req.result;
        dbInstance.onversionchange = () => {
          // Another tab is upgrading the DB; release our handle so it can proceed.
          dbInstance.close();
          dbInstance = null;
        };
        resolve(dbInstance);
      };

      req.onerror = () => {
        openPromise = null;
        reject(
          new Error(
            "INDEXEDDB_OPEN_FAILED: " + (req.error ? req.error.message : "Unknown IndexedDB error")
          )
        );
      };

      req.onblocked = () => {
        reject(new Error("INDEXEDDB_BLOCKED: Close other SnapClean tabs and reload."));
      };
    });

    return openPromise;
  }

  // Hands back the live store object(s) synchronously (same task, before the
  // transaction completes) plus a `done` promise that resolves on completion.
  // Callers issue their get/put/delete calls immediately, then `await done`.
  function withStores(storeNames, mode) {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(storeNames, mode);
          const stores = Array.isArray(storeNames)
            ? storeNames.map((n) => t.objectStore(n))
            : t.objectStore(storeNames);
          const done = new Promise((res, rej) => {
            t.oncomplete = () => res();
            t.onerror = () =>
              rej(new Error("INDEXEDDB_TX_FAILED: " + (t.error ? t.error.message : "transaction failed")));
            t.onabort = () =>
              rej(new Error("INDEXEDDB_TX_ABORTED: " + (t.error ? t.error.message : "transaction aborted")));
          });
          resolve({ stores, done });
        })
    );
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error("INDEXEDDB_REQUEST_FAILED: " + (req.error ? req.error.message : "request failed")));
    });
  }

  // ---- Accounts -----------------------------------------------------------

  async function getAllAccounts() {
    const { stores, done } = await withStores(ACCOUNTS_STORE, "readonly");
    const result = await reqToPromise(stores.getAll());
    await done;
    return result;
  }

  async function getAccount(usernameKey) {
    const { stores, done } = await withStores(ACCOUNTS_STORE, "readonly");
    const result = await reqToPromise(stores.get(usernameKey));
    await done;
    return result || null;
  }

  /** Update/insert exactly one account record. Does NOT touch any other record. */
  async function putAccount(account) {
    const { stores, done } = await withStores(ACCOUNTS_STORE, "readwrite");
    stores.put(account);
    await done;
    return account;
  }

  /** Bulk insert/replace many accounts inside a single transaction (used only on import). */
  async function putAccounts(accounts) {
    const { stores, done } = await withStores(ACCOUNTS_STORE, "readwrite");
    for (const a of accounts) stores.put(a);
    await done;
    return accounts.length;
  }

  async function deleteAllAccounts() {
    const { stores, done } = await withStores(ACCOUNTS_STORE, "readwrite");
    stores.clear();
    await done;
  }

  async function countAccounts() {
    const { stores, done } = await withStores(ACCOUNTS_STORE, "readonly");
    const result = await reqToPromise(stores.count());
    await done;
    return result;
  }

  // ---- Meta (settings / import log / review+undo state) -------------------

  async function getMeta(key, fallback = null) {
    const { stores, done } = await withStores(META_STORE, "readonly");
    const result = await reqToPromise(stores.get(key));
    await done;
    return result ? result.value : fallback;
  }

  async function setMeta(key, value) {
    const { stores, done } = await withStores(META_STORE, "readwrite");
    stores.put({ key, value });
    await done;
  }

  async function deleteMeta(key) {
    const { stores, done } = await withStores(META_STORE, "readwrite");
    stores.delete(key);
    await done;
  }

  async function wipeDatabase() {
    const { stores, done } = await withStores([ACCOUNTS_STORE, META_STORE], "readwrite");
    stores[0].clear();
    stores[1].clear();
    await done;
  }

  // ---- Undo stack (kept in `meta` under key "undoStack", capped) ----------

  const UNDO_LIMIT = 100;

  async function pushUndo(entry) {
    const stack = (await getMeta("undoStack", [])) || [];
    stack.push(entry);
    while (stack.length > UNDO_LIMIT) stack.shift();
    await setMeta("undoStack", stack);
    return stack.length;
  }

  async function popUndo() {
    const stack = (await getMeta("undoStack", [])) || [];
    const entry = stack.pop();
    await setMeta("undoStack", stack);
    return entry || null;
  }

  async function peekUndoCount() {
    const stack = (await getMeta("undoStack", [])) || [];
    return stack.length;
  }

  global.SnapCleanDB = {
    openDB,
    getAllAccounts,
    getAccount,
    putAccount,
    putAccounts,
    deleteAllAccounts,
    countAccounts,
    getMeta,
    setMeta,
    deleteMeta,
    wipeDatabase,
    pushUndo,
    popUndo,
    peekUndoCount,
  };
})(typeof window !== "undefined" ? window : globalThis);
