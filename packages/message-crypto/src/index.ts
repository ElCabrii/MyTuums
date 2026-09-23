import {
  CompactEncrypt,
  CompactSign,
  GeneralEncrypt,
  calculateJwkThumbprint,
  compactDecrypt,
  compactVerify,
  exportJWK,
  generalDecrypt,
  generateKeyPair,
  importJWK,
} from "jose";
import { z } from "zod";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Public-only, fixed-curve keys. Private parameters and JOSE header URLs are rejected. */
export const publicKeySchema = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: coordinate,
  y: coordinate,
});
const privateKeySchema = publicKeySchema.extend({ d: coordinate });
export const identitySchema = z.strictObject({
  userId: z.string().min(1).max(128),
  encryption: publicKeySchema,
  signing: publicKeySchema,
});
const backupSchema = z.strictObject({
  version: z.literal(1),
  userId: z.string().min(1).max(128),
  encryption: privateKeySchema,
  signing: privateKeySchema,
});
export type PublicIdentity = z.infer<typeof identitySchema>;
export type PublicKey = z.infer<typeof publicKeySchema>;
export type PrivateIdentity = z.infer<typeof backupSchema>;

/** Non-extractable keys are persisted by the browser; exportable JWKs exist only during setup/recovery. */
export interface LocalIdentity {
  public: PublicIdentity;
  encryption: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  signing: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
}

export async function unlockIdentity(value: PrivateIdentity): Promise<LocalIdentity> {
  const identity = backupSchema.parse(value);
  const encryption = await importJWK({ ...identity.encryption, ext: false }, "ECDH-ES");
  const signing = await importJWK({ ...identity.signing, ext: false }, "ES256");
  if (encryption instanceof Uint8Array || signing instanceof Uint8Array)
    throw new Error("Invalid private key.");
  return { public: publicIdentity(identity), encryption, signing };
}

const encoded = z
  .string()
  .min(1)
  .max(32_768)
  .regex(/^[A-Za-z0-9_-]+$/);
export const envelopeSchema = z.strictObject({
  protected: encoded,
  iv: z
    .string()
    .length(16)
    .regex(/^[A-Za-z0-9_-]+$/),
  ciphertext: encoded,
  tag: z
    .string()
    .length(22)
    .regex(/^[A-Za-z0-9_-]+$/),
  recipients: z
    .array(
      z.strictObject({
        encrypted_key: encoded,
        header: z.strictObject({
          alg: z.literal("ECDH-ES+A256KW"),
          kid: coordinate,
          epk: publicKeySchema,
        }),
      }),
    )
    .length(2),
});
export type MessageEnvelope = z.infer<typeof envelopeSchema>;

export async function validateEnvelopeRecipients(
  envelope: MessageEnvelope,
  sender: PublicIdentity,
  recipient: PublicIdentity,
): Promise<void> {
  const expected = await Promise.all(
    [sender.encryption, recipient.encryption].map((key) => calculateJwkThumbprint(key)),
  );
  const actual = envelope.recipients.map((entry) => entry.header.kid);
  if (new Set(actual).size !== 2 || expected.some((id) => !actual.includes(id)))
    throw new Error("Incorrect message recipients.");
}

export const messagePlaintextSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  senderId: z.string().min(1).max(128),
  recipientId: z.string().min(1).max(128),
  body: z.string().trim().max(2000),
});
export type MessagePlaintext = z.infer<typeof messagePlaintextSchema>;

function publicPart(key: PublicKey): PublicKey {
  return { kty: key.kty, crv: key.crv, x: key.x, y: key.y };
}

export function publicIdentity(identity: PrivateIdentity): PublicIdentity {
  return {
    userId: identity.userId,
    encryption: publicPart(identity.encryption),
    signing: publicPart(identity.signing),
  };
}

export async function createIdentity(userId: string): Promise<PrivateIdentity> {
  const encryption = await generateKeyPair("ECDH-ES", { crv: "P-256", extractable: true });
  const signing = await generateKeyPair("ES256", { extractable: true });
  return backupSchema.parse({
    version: 1,
    userId,
    encryption: await exportJWK(encryption.privateKey),
    signing: await exportJWK(signing.privateKey),
  });
}

/** Validates actual curve points, in addition to the public-only wire schema. */
export async function validateIdentity(value: PublicIdentity): Promise<void> {
  const identity = identitySchema.parse(value);
  await importJWK(identity.encryption, "ECDH-ES");
  await importJWK(identity.signing, "ES256");
}

export async function identityFingerprint(identity: PublicIdentity): Promise<string> {
  const bytes = encoder.encode(JSON.stringify(identitySchema.parse(identity)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Signed plaintext is disclosed only to participants, or deliberately in a report. */
export async function encryptMessage(
  input: MessagePlaintext,
  sender: LocalIdentity,
  recipient: PublicIdentity,
): Promise<MessageEnvelope> {
  const message = messagePlaintextSchema.parse(input);
  if (
    message.senderId !== sender.public.userId ||
    message.recipientId !== recipient.userId ||
    sender.public.userId === recipient.userId
  ) {
    throw new Error("Message identity mismatch.");
  }
  const signed = await new CompactSign(encoder.encode(JSON.stringify(message)))
    .setProtectedHeader({ alg: "ES256", typ: "mytuums-message-v1" })
    .sign(sender.signing);
  const encryption = new GeneralEncrypt(encoder.encode(signed)).setProtectedHeader({
    enc: "A256GCM",
    typ: "mytuums-message-v1",
  });
  for (const identity of [sender.public, recipient]) {
    encryption
      .addRecipient(await importJWK(identity.encryption, "ECDH-ES+A256KW"))
      .setUnprotectedHeader({
        alg: "ECDH-ES+A256KW",
        kid: await calculateJwkThumbprint(identity.encryption),
      });
  }
  return envelopeSchema.parse(await encryption.encrypt());
}

export async function verifyDisclosedMessage(
  signed: string,
  sender: PublicIdentity,
): Promise<MessagePlaintext> {
  if (signed.length > 32_768) throw new Error("Message too large.");
  const result = await compactVerify(signed, await importJWK(sender.signing, "ES256"), {
    algorithms: ["ES256"],
  });
  if (result.protectedHeader.typ !== "mytuums-message-v1") throw new Error("Invalid message type.");
  const message = messagePlaintextSchema.parse(JSON.parse(decoder.decode(result.payload)));
  if (message.senderId !== sender.userId) throw new Error("Message identity mismatch.");
  return message;
}

export async function decryptMessage(
  envelope: MessageEnvelope,
  reader: LocalIdentity,
  sender: PublicIdentity,
  expected: Pick<MessagePlaintext, "id" | "senderId" | "recipientId">,
): Promise<{ message: MessagePlaintext; disclosure: string }> {
  const result = await generalDecrypt(envelopeSchema.parse(envelope), reader.encryption, {
    keyManagementAlgorithms: ["ECDH-ES+A256KW"],
    contentEncryptionAlgorithms: ["A256GCM"],
  });
  if (result.protectedHeader?.typ !== "mytuums-message-v1")
    throw new Error("Invalid message type.");
  const disclosure = decoder.decode(result.plaintext);
  const message = await verifyDisclosedMessage(disclosure, sender);
  if (
    message.id !== expected.id ||
    message.senderId !== expected.senderId ||
    message.recipientId !== expected.recipientId ||
    (reader.public.userId !== message.senderId && reader.public.userId !== message.recipientId)
  ) {
    throw new Error("Message identity mismatch.");
  }
  return { message, disclosure };
}

/** The recovery public key is safe to distribute. Its private half is a separate deployment secret. */
export async function encryptRecoveryBackup(
  identity: PrivateIdentity,
  recoveryKey: PublicKey,
): Promise<string> {
  return new CompactEncrypt(encoder.encode(JSON.stringify(backupSchema.parse(identity))))
    .setProtectedHeader({ alg: "ECDH-ES", enc: "A256GCM", typ: "mytuums-key-backup-v1" })
    .encrypt(await importJWK(publicKeySchema.parse(recoveryKey), "ECDH-ES"));
}

export async function decryptRecoveryBackup(
  backup: string,
  recoveryKey: z.infer<typeof privateKeySchema>,
  expected: PublicIdentity,
): Promise<PrivateIdentity> {
  if (backup.length > 8192) throw new Error("Backup too large.");
  const result = await compactDecrypt(
    backup,
    await importJWK(privateKeySchema.parse(recoveryKey), "ECDH-ES"),
    {
      keyManagementAlgorithms: ["ECDH-ES"],
      contentEncryptionAlgorithms: ["A256GCM"],
    },
  );
  if (result.protectedHeader.typ !== "mytuums-key-backup-v1")
    throw new Error("Invalid backup type.");
  const identity = backupSchema.parse(JSON.parse(decoder.decode(result.plaintext)));
  if (
    (await identityFingerprint(publicIdentity(identity))) !== (await identityFingerprint(expected))
  )
    throw new Error("Backup identity mismatch.");
  // Import both private keys now so corrupt backups fail before enrolment or recovery succeeds.
  await importJWK(identity.encryption, "ECDH-ES");
  await importJWK(identity.signing, "ES256");
  return identity;
}

export const recoveryPrivateKeySchema = privateKeySchema;
export const privateIdentitySchema = backupSchema;
