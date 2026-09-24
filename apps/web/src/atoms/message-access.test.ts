import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createIdentity,
  publicIdentity,
  unlockIdentity,
  type LocalIdentity,
  type PublicIdentity,
} from "@my-tuums/message-crypto";
import { installTestClient } from "@/lib/orpc";
import * as keyStore from "@/lib/message-key-store";
import { QueryClient } from "@tanstack/react-query";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { setTestSession, signedInSession, signedOutSession } from "@/test/auth-fixture";
import { messageAccessAtom } from "./message-access";
import { sessionAtom } from "./session";

const viewer = "message-access-viewer";
const recoveryIdentity = await createIdentity("recovery");
const recovery = { id: "test-key", publicKey: publicIdentity(recoveryIdentity).encryption };
let registered: PublicIdentity | null;
let stored: LocalIdentity | null;
let store: ReturnType<typeof createStore>;
let queryClient: QueryClient;
let unsubscribe: () => void;
let unsubscribeSession: () => void;
const registration = vi.fn(({ identity }: { identity: PublicIdentity }) => {
  registered = identity;
  return Promise.resolve({ registered: true });
});
const status = vi.fn(() => Promise.resolve({ identity: registered, recovery }));

beforeEach(() => {
  store = createStore();
  queryClient = new QueryClient();
  store.set(queryClientAtom, queryClient);
  registered = null;
  stored = null;
  registration.mockClear();
  status.mockClear();
  installTestClient({ messageKey: { status, register: registration } });
  vi.spyOn(keyStore, "readMessageKey").mockImplementation(() => Promise.resolve(stored));
  vi.spyOn(keyStore, "writeMessageKey").mockImplementation((identity) => {
    stored = identity;
    return Promise.resolve();
  });
  setTestSession(signedInSession({ id: viewer }));
  unsubscribeSession = store.sub(sessionAtom, () => {});
  unsubscribe = () => {};
});

afterEach(() => {
  unsubscribe();
  unsubscribeSession();
  queryClient.clear();
  vi.restoreAllMocks();
});

async function access() {
  unsubscribe = store.sub(messageAccessAtom, () => {});
  await vi.waitFor(() => expect(store.get(messageAccessAtom).isSuccess).toBe(true));
  return store.get(messageAccessAtom).data;
}

it("automatically prepares a new account and preserves its keys on subsequent visits", async () => {
  const first = await access();
  expect(first?.identity?.userId).toBe(viewer);
  expect(first?.local?.public).toEqual(registered);
  expect(stored?.public).toEqual(registered);
  expect(first?.local?.encryption.extractable).toBe(false);
  expect(first?.local?.signing.extractable).toBe(false);
  const identity = registered;
  await store.get(messageAccessAtom).refetch();
  expect(store.get(messageAccessAtom).data?.local?.public).toEqual(identity);
  expect(registered).toEqual(identity);
});

it("leaves an existing identity locked for email recovery instead of replacing it", async () => {
  registered = publicIdentity(await createIdentity(viewer));
  const identity = registered;
  const result = await access();
  expect(result?.identity).toEqual(identity);
  expect(result?.local).toBeNull();
  expect(registered).toEqual(identity);
  expect(stored).toBeNull();
});

it("opens an existing identity immediately on a trusted browser", async () => {
  stored = await unlockIdentity(await createIdentity(viewer));
  registered = stored.public;
  expect((await access())?.local).toEqual(stored);
});

it("uses the winning identity when another device registers at the same time", async () => {
  const winner = publicIdentity(await createIdentity(viewer));
  registration.mockImplementationOnce(() => {
    registered = winner;
    return Promise.reject(new Error("CONFLICT"));
  });
  const result = await access();
  expect(result?.identity).toEqual(winner);
  expect(result?.local).toBeNull();
  expect(stored).toBeNull();
});

it("keeps accepted keys when the registration response is lost", async () => {
  registration.mockImplementationOnce(({ identity }) => {
    registered = identity;
    return Promise.reject(new Error("Network response lost"));
  });
  const result = await access();
  expect(result?.local?.public).toEqual(registered);
  expect(stored?.public).toEqual(registered);
});

it("allows retrying a failed setup without making messaging optional", async () => {
  registration.mockRejectedValueOnce(new Error("Unavailable"));
  unsubscribe = store.sub(messageAccessAtom, () => {});
  await vi.waitFor(() => expect(store.get(messageAccessAtom).isError).toBe(true));
  expect(stored).toBeNull();
  const retried = await store.get(messageAccessAtom).refetch();
  expect(retried.data?.local?.public).toEqual(registered);
  expect(registered?.userId).toBe(viewer);
});

it("does not register an account after sign-out while status is loading", async () => {
  let resolveStatus: (value: Awaited<ReturnType<typeof status>>) => void = () => {};
  status.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveStatus = resolve;
    }),
  );
  unsubscribe = store.sub(messageAccessAtom, () => {});
  await vi.waitFor(() => expect(store.get(messageAccessAtom).isFetching).toBe(true));
  setTestSession(signedOutSession());
  resolveStatus({ identity: null, recovery });
  await vi.waitFor(() =>
    expect(queryClient.getQueryState(["message-access", viewer])?.fetchStatus).toBe("idle"),
  );
  expect(registered).toBeNull();
  expect(stored).toBeNull();
});
