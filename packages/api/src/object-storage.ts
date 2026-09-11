/** Native object operations available to application procedures. Delivery is separate. */
export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  head(key: string): Promise<{ contentType: string } | null>;
  /** Bounded buffered reads for image processing; HTTP delivery uses a streaming binding. */
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
}

/** Inventory and bulk deletion belong to maintenance, never API context. */
export interface ObjectStorageMaintenance extends ObjectStorage {
  listByPrefix(prefix: string): Promise<string[]>;
  removeMany(keys: string[]): Promise<number>;
  removeByPrefix(prefix: string): Promise<number>;
}
