import { runInNewContext as runInVmSandbox } from "node:vm";
import { expect, it } from "vitest";
import { serviceWorkerSource } from "../../pwa-plugin";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";

type WorkerEvent = {
  waitUntil(promise: Promise<unknown>): void;
  notification: { close(): void };
  data: { url: string; body: string };
};

it.each([
  ["en", en.push_notification_body],
  ["fr", fr.push_notification_body],
])("shows a generic %s alert and opens only the inbox", async (language, body) => {
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  const alerts: { title: string; body: string; tag: string }[] = [];
  const opened: string[] = [];
  let closed = false;
  let focused = false;
  const windows: { url: string; focus(): Promise<void> }[] = [];
  runInVmSandbox(serviceWorkerSource("shell", "runtime", []), {
    URL,
    self: {
      location: { origin: "https://mytuums.com" },
      navigator: { language },
      registration: {
        showNotification: (title: string, options: { body: string; tag: string }) => {
          alerts.push({ title, ...options });
          return Promise.resolve();
        },
      },
      clients: {
        matchAll: () => Promise.resolve(windows),
        openWindow: (url: string) => {
          opened.push(url);
          return Promise.resolve();
        },
      },
      addEventListener: (name: string, handler: (event: WorkerEvent) => void) =>
        handlers.set(name, handler),
    },
  });
  async function dispatch(type: string) {
    const pending: Promise<unknown>[] = [];
    handlers.get(type)?.({
      waitUntil: (work) => pending.push(work),
      notification: {
        close: () => {
          closed = true;
        },
      },
      data: { url: "https://evil.example/", body: "private content" },
    });
    await Promise.all(pending);
  }
  await dispatch("push");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ title: "MyTuums", body, tag: "mytuums-inbox" });
  await dispatch("notificationclick");
  expect(closed).toBe(true);
  expect(opened).toEqual(["/notifications"]);
  windows.push({
    url: "https://mytuums.com/notifications",
    focus: () => {
      focused = true;
      return Promise.resolve();
    },
  });
  await dispatch("notificationclick");
  expect(focused).toBe(true);
  expect(opened).toHaveLength(1);
});
