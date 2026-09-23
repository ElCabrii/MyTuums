import { z } from "zod";
import {
  decryptRecoveryBackup,
  encryptRecoveryBackup,
  publicKeySchema,
  recoveryPrivateKeySchema,
  type PublicIdentity,
  type PublicKey,
} from "@my-tuums/message-crypto";

/** Kept separate from message delivery: no ordinary message procedure receives private keys. */
export interface MessageRecoveryKeys {
  active: { id: string; publicKey: PublicKey };
  validateBackup(backup: string, identity: PublicIdentity): Promise<void>;
  recover(
    backup: string,
    keyId: string,
    identity: PublicIdentity,
    transportKey: PublicKey,
  ): Promise<string>;
}

/** Explicit, independent secret; old key versions must remain until their backups are rewrapped. */
export function createMessageRecoveryKeys(configuration: string): MessageRecoveryKeys {
  const config = parseConfiguration(configuration);
  const active = config.keys[config.active];
  if (!active) throw new Error("Missing active recovery key.");
  const publicKey = publicKeySchema.parse({
    kty: active.kty,
    crv: active.crv,
    x: active.x,
    y: active.y,
  });
  return {
    active: { id: config.active, publicKey },
    async validateBackup(backup, identity) {
      await decryptRecoveryBackup(backup, active, identity);
    },
    async recover(backup, keyId, identity, transportKey) {
      const key = config.keys[keyId];
      if (!key) throw new Error("Recovery key unavailable.");
      const recovered = await decryptRecoveryBackup(backup, key, identity);
      return encryptRecoveryBackup(recovered, transportKey);
    },
  };
}

function parseConfiguration(configuration: string) {
  try {
    return z
      .strictObject({
        active: z.string().min(1).max(64),
        keys: z.record(z.string(), recoveryPrivateKeySchema),
      })
      .parse(JSON.parse(configuration));
  } catch {
    // JSON parser diagnostics can include fragments of a malformed private key.
    throw new Error("Invalid message recovery keyring configuration.");
  }
}
