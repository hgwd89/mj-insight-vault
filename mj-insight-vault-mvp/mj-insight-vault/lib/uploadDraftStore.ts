export type UploadDraftRow = {
  name: string;
  status: string;
  note?: string;
};

export type StoredDraftFile = {
  name: string;
  type: string;
  lastModified: number;
  blob: Blob;
};

export type UploadDraft = {
  version: 1;
  memo: string;
  date: string;
  autoOcr: boolean;
  batchId?: string;
  rows: UploadDraftRow[];
  files: StoredDraftFile[];
  savedAt: number;
};

const DB_NAME = 'mj-upload-draft-v1';
const STORE_NAME = 'uploadDrafts';
const DRAFT_KEY = 'current';

function hasIndexedDb() {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function openUploadDraftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!hasIndexedDb()) {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open upload draft DB'));
  });
}

export function fileToStoredDraftFile(file: File): StoredDraftFile {
  return {
    name: file.name,
    type: file.type,
    lastModified: file.lastModified,
    blob: file
  };
}

export function storedDraftFileToFile(file: StoredDraftFile): File {
  return new File([file.blob], file.name, {
    type: file.type,
    lastModified: file.lastModified
  });
}

export async function readUploadDraft(): Promise<UploadDraft | null> {
  try {
    const db = await openUploadDraftDb();
    return await new Promise<UploadDraft | null>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(DRAFT_KEY);

      request.onsuccess = () => {
        const draft = request.result as UploadDraft | undefined;
        resolve(draft?.version === 1 ? draft : null);
      };
      request.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
      tx.onabort = () => db.close();
    });
  } catch {
    return null;
  }
}

export async function writeUploadDraft(draft: UploadDraft): Promise<void> {
  try {
    const db = await openUploadDraftDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(draft, DRAFT_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error('Failed to write upload draft'));
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error || new Error('Upload draft write aborted'));
      };
    });
  } catch {
    // Draft persistence is best-effort. Never break upload UI because of IndexedDB failure.
  }
}

export async function clearUploadDraft(): Promise<void> {
  try {
    const db = await openUploadDraftDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(DRAFT_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error('Failed to clear upload draft'));
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error || new Error('Upload draft clear aborted'));
      };
    });
  } catch {
    // Best-effort only.
  }
}
