import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installTestClient } from "@/lib/orpc";
import { renderWithProviders } from "@/test/render";
import { BrowserPushSettings } from "./browser-push-settings";
import { m } from "@/paraglide/messages.js";

const publicKey = `B${"a".repeat(86)}`;
const endpoint = "https://fcm.googleapis.com/fcm/send/device";
let serverEndpoint: string | null;
let browserSubscription: {
  endpoint: string;
  unsubscribe: () => Promise<boolean>;
  options: { applicationServerKey: ArrayBuffer };
} | null;
const fakeClient = {
  push: {
    status: vi.fn(() => Promise.resolve({ publicKey, endpoint: serverEndpoint })),
    subscribe: vi.fn(() => {
      serverEndpoint = endpoint;
      return Promise.resolve({ enabled: true });
    }),
    unsubscribe: vi.fn(() => {
      serverEndpoint = null;
      return Promise.resolve({ enabled: false });
    }),
  },
};
const notificationApi = {
  permission: "default",
  requestPermission: vi.fn(() => {
    notificationApi.permission = "granted";
    return Promise.resolve("granted");
  }),
};
const unsubscribe = vi.fn(() => {
  browserSubscription = null;
  return Promise.resolve(true);
});
const subscribe = vi.fn((options: { applicationServerKey: Uint8Array<ArrayBuffer> }) => {
  browserSubscription = {
    endpoint,
    unsubscribe,
    options: { applicationServerKey: options.applicationServerKey.buffer },
  };
  return Promise.resolve(browserSubscription);
});
const registration = {
  active: {},
  installing: null,
  waiting: null,
  update: () => Promise.resolve(),
  getNotifications: () => Promise.resolve([]),
  pushManager: { getSubscription: () => Promise.resolve(browserSubscription), subscribe },
};
beforeEach(() => {
  vi.clearAllMocks();
  serverEndpoint = null;
  browserSubscription = null;
  notificationApi.permission = "default";
  installTestClient(fakeClient);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", notificationApi);
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: () => Promise.resolve(registration) },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

it("only requests permission on opt-in and turns delivery off for this browser", async () => {
  const user = userEvent.setup();
  await renderWithProviders(<BrowserPushSettings />, { signedInAs: true });
  const enable = await screen.findByRole("button", { name: m.push_enable() });
  await vi.waitFor(() => expect(enable).toBeEnabled());
  expect(notificationApi.requestPermission).not.toHaveBeenCalled();
  await user.click(enable);
  const disable = await screen.findByRole("button", { name: m.push_disable() });
  expect(fakeClient.push.subscribe).toHaveBeenCalledWith({
    endpoint,
    applicationServerKey: publicKey,
  });
  await user.click(disable);
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: m.push_enable() })).toBeEnabled(),
  );
  expect(serverEndpoint).toBeNull();
  expect(browserSubscription).toBeNull();
});

it("explains denied permission without repeatedly prompting", async () => {
  notificationApi.permission = "denied";
  await renderWithProviders(<BrowserPushSettings />, { signedInAs: true });
  expect(await screen.findByText(m.push_blocked())).toBeInTheDocument();
  expect(screen.getByRole("button", { name: m.push_enable() })).toBeDisabled();
  expect(notificationApi.requestPermission).not.toHaveBeenCalled();
});

it("guides unsupported browsers without offering a broken toggle", async () => {
  vi.stubGlobal("isSecureContext", false);
  await renderWithProviders(<BrowserPushSettings />, { signedInAs: true });
  expect(await screen.findByText(m.push_unsupported())).toBeInTheDocument();
  expect(screen.getByRole("button", { name: m.push_enable() })).toBeDisabled();
});

it("keeps enable available after subscription persistence fails", async () => {
  fakeClient.push.subscribe.mockRejectedValueOnce(new Error("offline"));
  const user = userEvent.setup();
  await renderWithProviders(<BrowserPushSettings />, { signedInAs: true });
  const enable = screen.getByRole("button", { name: m.push_enable() });
  await vi.waitFor(() => expect(enable).toBeEnabled());
  await user.click(enable);
  expect(await screen.findByRole("alert")).toHaveTextContent(m.push_error());
  expect(screen.getByRole("button", { name: m.push_enable() })).toBeEnabled();
  expect(serverEndpoint).toBeNull();
});
