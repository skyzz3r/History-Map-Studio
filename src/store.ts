// Storage that scales with the disk, and files that live on the user's disk.
//
// Both documents here outgrow localStorage in normal use: the edit patch layer
// snapshots polygon geometry per corrected region, and annotations hold
// downscaled photos as data URLs. localStorage is the wrong home for both, for
// three reasons — measured in Chrome 141 on this machine:
//
//   * It has a hard cap. 32 MB was accepted here and 64 MB threw
//     QuotaExceededError; Firefox and Safari still stop around 5-10 MB. Past it
//     `setItem` throws and the existing catch keeps the work on screen and
//     loses it on reload, which is the worst possible failure for an editor.
//   * It is SYNCHRONOUS and string-only, so every save stringifies the whole
//     document on the main thread. That is a frame budget spent on JSON for
//     something no one is waiting to read.
//   * IndexedDB has neither problem: the quota is a share of free disk (2.9 GB
//     here), writes are off the critical path, and it stores structured clones,
//     so geometry never becomes a string at all. A 24 MB write took 96 ms.
//
// ponytail: two keys, read once at boot, written whole. No query language, no
// indexes, no Dexie. Upgrade path is an object store per document if a single
// write ever gets slow enough to notice — measure `set()` before adding one.

const DB = "history-map";
const KV = "kv";

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(KV);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

function run<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return open().then(
    (d) =>
      new Promise<T>((res, rej) => {
        const t = d.transaction(KV, mode);
        const req = fn(t.objectStore(KV));
        req.onsuccess = () => res(req.result as T);
        // Both are needed: the request can succeed and the transaction still
        // abort on quota, which is exactly the case this file exists for.
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      }),
  );
}

export const get = <T>(key: string): Promise<T | undefined> =>
  run<T | undefined>("readonly", (s) => s.get(key));

export const set = (key: string, value: unknown): Promise<void> =>
  run<void>("readwrite", (s) => s.put(value, key));

/**
 * Read a document, promoting whatever localStorage still holds under the same
 * key the first time.
 *
 * The localStorage entry is REMOVED after a successful promotion, which is half
 * the point: leaving the old copy behind keeps the origin near its cap, so the
 * next `setItem` anywhere else in the app still throws.
 *
 * Any failure returns undefined rather than throwing. A browser with IndexedDB
 * blocked (private mode, hardened settings) must still open the map.
 */
export async function load<T>(key: string, parse: (raw: unknown) => T): Promise<T | undefined> {
  try {
    const v = await get<unknown>(key);
    if (v !== undefined) return parse(v);
  } catch (e) {
    console.warn("could not read", key, e);
    return undefined;
  }
  const old = localStorage.getItem(key);
  if (old === null) return undefined;
  try {
    const doc = parse(JSON.parse(old));
    await set(key, doc);
    localStorage.removeItem(key);
    return doc;
  } catch (e) {
    console.warn("could not migrate", key, e);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The user's own disk
// ---------------------------------------------------------------------------
//
// A file handle, not a directory handle. A directory prompt asks for authority
// over every file in Documents to write one project file, and it still cannot
// name the file for the user — `showSaveFilePicker` does both jobs with a
// narrower grant. The handle is kept so re-saving is one click, not one dialog.
//
// Chromium only. Firefox and Safari have neither picker, so callers fall back to
// the download/upload path that already works everywhere.

const HANDLE = "project:handle";

type Handle = FileSystemFileHandle & {
  queryPermission(o: { mode: string }): Promise<PermissionState>;
  requestPermission(o: { mode: string }): Promise<PermissionState>;
};

export const canUseFiles = () =>
  typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";

/** Ask once, then only if the grant has lapsed (it does not survive a restart). */
async function allowed(h: Handle, mode: "read" | "readwrite"): Promise<boolean> {
  if ((await h.queryPermission({ mode })) === "granted") return true;
  return (await h.requestPermission({ mode })) === "granted";
}

async function savedHandle(): Promise<Handle | null> {
  try {
    return (await get<Handle>(HANDLE)) ?? null;
  } catch {
    return null;
  }
}

const cancelled = (e: unknown) => (e as DOMException)?.name === "AbortError";

/**
 * Write `text` to the file the user picked, prompting only when there is no
 * usable handle yet (or `pickNew` asks for Save As).
 *
 * Returns the file name written, or null when the user cancelled. Anything else
 * throws: a save that silently did nothing is how work gets lost.
 */
export async function saveProject(
  text: string,
  suggestedName = "history-map.json",
  pickNew = false,
): Promise<string | null> {
  let h = pickNew ? null : await savedHandle();
  if (h && !(await allowed(h, "readwrite"))) h = null;
  if (!h) {
    try {
      h = (await (globalThis as any).showSaveFilePicker({
        suggestedName,
        types: [{ description: "History Map project", accept: { "application/json": [".json"] } }],
      })) as Handle;
    } catch (e) {
      if (cancelled(e)) return null;
      throw e;
    }
    await set(HANDLE, h).catch(() => {}); // a non-persisted handle still saves
  }
  const w = await h.createWritable();
  await w.write(text);
  await w.close();
  return h.name;
}

/** Read a project file the user picks, and remember it as the save target. */
export async function openProject(): Promise<string | null> {
  let h: Handle;
  try {
    [h] = (await (globalThis as any).showOpenFilePicker({
      types: [{ description: "History Map project", accept: { "application/json": [".json"] } }],
    })) as Handle[];
  } catch (e) {
    if (cancelled(e)) return null;
    throw e;
  }
  const text = await (await h.getFile()).text();
  await set(HANDLE, h).catch(() => {});
  return text;
}

/** Name of the file a plain Save would overwrite, for the button's label. */
export async function projectName(): Promise<string | null> {
  const h = await savedHandle();
  return h?.name ?? null;
}
