/**
 * Recordings attached to charts, kept in IndexedDB (localStorage is far too small
 * for audio). Keys are `ChartAudio.id`. Every call tolerates a missing IndexedDB
 * (private windows, blocked storage) by resolving to null / no-op.
 */

const DB = 'keystage-audio';
const STORE = 'blobs';

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          tx.oncomplete = () => db.close();
        } catch {
          resolve(null);
        }
      }),
  );
}

export async function putAudio(id: string, blob: Blob): Promise<boolean> {
  return (await run('readwrite', (s) => s.put(blob, id))) !== null;
}

export async function getAudio(id: string): Promise<Blob | null> {
  return (await run<Blob | undefined>('readonly', (s) => s.get(id))) ?? null;
}

export async function deleteAudio(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}

export async function listAudioIds(): Promise<string[]> {
  return ((await run<IDBValidKey[]>('readonly', (s) => s.getAllKeys())) ?? []).map(String);
}

export function newAudioId(): string {
  return 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
