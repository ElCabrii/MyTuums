import { describe, expect, it } from "vitest";
import {
  createIdentity,
  decryptMessage,
  decryptRecoveryBackup,
  encryptMessage,
  encryptRecoveryBackup,
  publicIdentity,
  unlockIdentity,
  verifyDisclosedMessage,
} from "./index.js";

async function exchange() {
  const alice = await createIdentity("alice");
  const bob = await createIdentity("bob");
  const message = {
    version: 1 as const,
    id: crypto.randomUUID(),
    senderId: "alice",
    recipientId: "bob",
    body: "A private message 👋",
  };
  const envelope = await encryptMessage(message, await unlockIdentity(alice), publicIdentity(bob));
  return { alice, bob, message, envelope };
}

describe("encrypted message boundaries", () => {
  it("lets both participants read an authenticated message while excluding a third account", async () => {
    const { alice, bob, message, envelope } = await exchange();
    expect(JSON.stringify(envelope)).not.toContain(message.body);
    for (const reader of [alice, bob]) {
      const result = await decryptMessage(
        envelope,
        await unlockIdentity(reader),
        publicIdentity(alice),
        message,
      );
      expect(result.message).toEqual(message);
      expect(await verifyDisclosedMessage(result.disclosure, publicIdentity(alice))).toEqual(
        message,
      );
    }
    const eve = await createIdentity("eve");
    await expect(
      decryptMessage(envelope, await unlockIdentity(eve), publicIdentity(alice), message),
    ).rejects.toThrow();
  });

  it("refuses tampering, another sender's identity, and ciphertext transplanted onto another message", async () => {
    const { alice, bob, message, envelope } = await exchange();
    const reader = await unlockIdentity(bob);
    const modified = {
      ...envelope,
      ciphertext: (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1),
    };
    await expect(
      decryptMessage(modified, reader, publicIdentity(alice), message),
    ).rejects.toThrow();
    await expect(decryptMessage(envelope, reader, publicIdentity(bob), message)).rejects.toThrow();
    await expect(
      decryptMessage(envelope, reader, publicIdentity(alice), {
        ...message,
        id: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      decryptMessage(envelope, reader, publicIdentity(alice), { ...message, recipientId: "eve" }),
    ).rejects.toThrow();
  });

  it("backs up an identity under a distinct recovery key and binds restoration to the registered public identity", async () => {
    const { alice, bob, message, envelope } = await exchange();
    const recovery = await createIdentity("recovery");
    const backup = await encryptRecoveryBackup(bob, publicIdentity(recovery).encryption);
    expect(backup).not.toContain(bob.encryption.d);
    const restored = await decryptRecoveryBackup(backup, recovery.encryption, publicIdentity(bob));
    expect(
      (
        await decryptMessage(
          envelope,
          await unlockIdentity(restored),
          publicIdentity(alice),
          message,
        )
      ).message.body,
    ).toBe(message.body);
    await expect(
      decryptRecoveryBackup(backup, alice.encryption, publicIdentity(bob)),
    ).rejects.toThrow();
    await expect(
      decryptRecoveryBackup(backup, recovery.encryption, publicIdentity(alice)),
    ).rejects.toThrow();
    const local = await unlockIdentity(restored);
    expect(local.encryption.extractable).toBe(false);
    expect(local.signing.extractable).toBe(false);
  });
});
