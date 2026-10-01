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
    queryFn: async ({ signal }) => {
      if (!userId) throw new Error("Sign in to open messages.");
      const assertCurrentUser = () => {
        signal.throwIfAborted();
        if (get(viewerIdAtom) !== userId || !get(protectedProductReadyAtom)) {
          throw new Error("Your session changed.");
        }
      };
      const initialize = async () => {
        assertCurrentUser();
        let status = await client.messageKey.status();
        let local = await readMessageKey(userId);
        assertCurrentUser();
        if (!status.identity && status.recovery) {
          const identity = await createIdentity(userId);
          const backup = await encryptRecoveryBackup(identity, status.recovery.publicKey);
          const candidate = publicIdentity(identity);
          assertCurrentUser();
          try {
            await client.messageKey.register({
              identity: candidate,
              backup,
              recoveryKeyId: status.recovery.id,
            });
            status = { ...status, identity: candidate };
          } catch (error) {
            // Another device may have registered first, or our successful
            // registration response was lost. The server identity wins.
            assertCurrentUser();
            status = await client.messageKey.status();
            if (!status.identity) throw error;
          }
          if (
            status.identity &&
            (await identityFingerprint(candidate)) === (await identityFingerprint(status.identity))
          ) {
            local = await unlockIdentity(identity);
            // Finish saving an accepted registration even if the query was
            // cancelled meanwhile; the keys remain scoped to the original user.
            await writeMessageKey(local);
          }
        }
        assertCurrentUser();
        const matches =
          local &&
          status.identity &&
          (await identityFingerprint(local.public)) ===
            (await identityFingerprint(status.identity));
        return { ...status, local: matches ? local : null };
      };
      // Tabs share IndexedDB. Hold the lock across registration AND storage so
      // a second tab reads the winning keys instead of requesting recovery.
      return navigator.locks
        ? navigator.locks.request(`mytuums-message-keys:${userId}`, { signal }, initialize)
        : initialize();
    },
  };
});

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
