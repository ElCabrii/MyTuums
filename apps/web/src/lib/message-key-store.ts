import { z } from "zod";
import { identitySchema, type LocalIdentity } from "@my-tuums/message-crypto";

const databaseName = "mytuums-message-keys-v1";

async function openKeys(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keys");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Message key storage is unavailable."));
  });
}

/** IndexedDB structured-clones non-extractable CryptoKeys; private JWKs are never persisted. */
export async function readMessageKey(userId: string): Promise<LocalIdentity | null> {
  const db = await openKeys();
  try {
    const value: unknown = await new Promise((resolve, reject) => {
      const request = db.transaction("keys").objectStore("keys").get(userId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Message key storage is unavailable."));
    });
    const stored = z
      .object({
        public: identitySchema,
        encryption: z.instanceof(CryptoKey).refine((key) => !key.extractable),
        signing: z.instanceof(CryptoKey).refine((key) => !key.extractable),
      })
      .safeParse(value);
    if (!stored.success || stored.data.public.userId !== userId) return null;
    return stored.data;
  } finally {
    db.close();
  }
}

export async function writeMessageKey(identity: LocalIdentity): Promise<void> {
  const db = await openKeys();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("keys", "readwrite");
      transaction.objectStore("keys").put(identity, identity.public.userId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error("Message key storage is unavailable."));
      transaction.onabort = () => reject(new Error("Message key storage is unavailable."));
    });
  } finally {
    db.close();
  }
}
