import { atomWithMutation, atomWithQuery, queryClientAtom } from "jotai-tanstack-query";
import { protectedProductReadyAtom } from "@/atoms/query-readiness";
import {
  activatePushWorker,
  browserPushRegistration,
  decodePushKey,
  supportsBrowserPush,
} from "@/lib/browser-push";
import { client } from "@/lib/orpc";

const queryKey = ["browser-push"];

export const browserPushAtom = atomWithQuery((get) => ({
  queryKey,
  enabled: get(protectedProductReadyAtom),
  queryFn: async ({ signal }) => {
    if (!supportsBrowserPush())
      return { supported: false, enabled: false, permission: "default", publicKey: null } as const;
    const [registration, configuration] = await Promise.all([
      browserPushRegistration(),
      client.push.status({}, { signal }),
    ]);
    const subscription = await registration?.pushManager.getSubscription();
    return {
      supported: true,
      enabled:
        Notification.permission === "granted" &&
        !!subscription &&
        subscription.endpoint === configuration.endpoint,
      permission: Notification.permission,
      publicKey: registration?.active ? configuration.publicKey : null,
    };
  },
}));

export const toggleBrowserPushAtom = atomWithMutation((get) => ({
  mutationFn: async (enable: boolean) => {
    const publicKey = get(browserPushAtom).data?.publicKey;
    // Called from the user's button click, before any subscription or network awaits.
    if (enable && (await Notification.requestPermission()) !== "granted") return;
    const registration = await browserPushRegistration();
    if (!registration?.active) throw new Error("Service worker unavailable.");
    let subscription = await registration.pushManager.getSubscription();
    if (!enable) {
      await client.push.unsubscribe({});
      await subscription?.unsubscribe();
      for (const notification of await registration.getNotifications({ tag: "mytuums-inbox" }))
        notification.close();
      return;
    }
    if (!publicKey) throw new Error("Push delivery unavailable.");
    await activatePushWorker(registration);
    const applicationServerKey = decodePushKey(publicKey);
    const existingKey = subscription?.options.applicationServerKey;
    if (
      subscription &&
      (!existingKey ||
        existingKey.byteLength !== applicationServerKey.length ||
        !new Uint8Array(existingKey).every((byte, index) => byte === applicationServerKey[index]))
    ) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
    await client.push.subscribe({
      endpoint: subscription.endpoint,
      applicationServerKey: publicKey,
    });
  },
  onSettled: () => get(queryClientAtom).invalidateQueries({ queryKey }),
}));
