import { atomWithMutation, atomWithQuery, queryClientAtom } from "jotai-tanstack-query";
import {
  createIdentity,
  decryptRecoveryBackup,
  encryptRecoveryBackup,
  identityFingerprint,
  publicIdentity,
  unlockIdentity,
  type PrivateIdentity,
} from "@my-tuums/message-crypto";
import { client } from "@/lib/orpc";
import { readMessageKey, writeMessageKey } from "@/lib/message-key-store";
import { viewerIdAtom } from "@/atoms/session";
import { protectedProductReadyAtom } from "@/atoms/query-readiness";

export const messageAccessAtom = atomWithQuery((get) => {
  const userId = get(viewerIdAtom);
  return {
    queryKey: ["message-access", userId],
    enabled: get(protectedProductReadyAtom) && userId !== null,
    retry: false,
    queryFn: async () => {
      if (!userId) throw new Error("Sign in to open messages.");
      const status = await client.messageKey.status();
      const local = await readMessageKey(userId);
      const matches =
        local &&
        status.identity &&
        (await identityFingerprint(local.public)) === (await identityFingerprint(status.identity));
      return { ...status, local: matches ? local : null };
    },
  };
});

export const setupMessageKeysAtom = atomWithMutation((get) => ({
  mutationFn: async () => {
    const userId = get(viewerIdAtom);
    const status = get(messageAccessAtom).data;
    if (!userId || !status?.recovery) throw new Error("Encryption setup is unavailable.");
    const identity = await createIdentity(userId);
    const backup = await encryptRecoveryBackup(identity, status.recovery.publicKey);
    await client.messageKey.register({
      identity: publicIdentity(identity),
      backup,
      recoveryKeyId: status.recovery.id,
    });
    if (get(viewerIdAtom) !== userId) throw new Error("Your session changed.");
    await writeMessageKey(await unlockIdentity(identity));
  },
  onSuccess: () => get(queryClientAtom).invalidateQueries({ queryKey: ["message-access"] }),
}));

interface RecoveryRequest {
  id: string;
  transport: PrivateIdentity;
  userId: string;
}

export const requestMessageRecoveryAtom = atomWithMutation((get) => ({
  mutationFn: async () => {
    const userId = get(viewerIdAtom);
    if (!userId) throw new Error("Sign in to recover messages.");
    const transport = await createIdentity(userId);
    const result = await client.messageKey.requestRecovery({
      transportKey: publicIdentity(transport).encryption,
    });
    if (get(viewerIdAtom) !== userId) throw new Error("Your session changed.");
    return { id: result.id, transport, userId };
  },
}));

/** Only the active mutation holds the ephemeral response key; it never enters localStorage or a URL. */
export const recoverMessageKeysAtom = atomWithMutation((get) => ({
  mutationFn: async ({ code, request }: { code: string; request: RecoveryRequest }) => {
    const userId = get(viewerIdAtom);
    const identity = get(messageAccessAtom).data?.identity;
    if (!userId || userId !== request.userId || !identity) throw new Error("Your session changed.");
    const { backup } = await client.messageKey.recover({ id: request.id, code: code.trim() });
    const recovered = await decryptRecoveryBackup(backup, request.transport.encryption, identity);
    if (get(viewerIdAtom) !== userId) throw new Error("Your session changed.");
    await writeMessageKey(await unlockIdentity(recovered));
  },
  onSuccess: () => get(queryClientAtom).invalidateQueries({ queryKey: ["message-access"] }),
}));
