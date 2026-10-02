export function supportsBrowserPush(): boolean {
  return (
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function decodePushKey(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );
}

/** Do not wait on serviceWorker.ready: dev mode and a failed registration may never resolve it. */
export async function browserPushRegistration() {
  if (!supportsBrowserPush()) return undefined;
  return navigator.serviceWorker.getRegistration("/");
}

/** An existing offline worker must acquire push handlers before a browser subscribes. */
export async function activatePushWorker(registration: ServiceWorkerRegistration): Promise<void> {
  await registration.update();
  const worker = registration.installing ?? registration.waiting;
  if (!worker) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Service worker update timed out.")), 10000);
    function finish(error?: Error) {
      clearTimeout(timer);
      worker?.removeEventListener("statechange", changed);
      if (error) reject(error);
      else resolve();
    }
    function changed() {
      if (worker?.state === "installed") worker.postMessage({ type: "ACTIVATE_BROWSER_PUSH" });
      if (worker?.state === "activated") finish();
      if (worker?.state === "redundant") finish(new Error("Service worker update failed."));
    }
    worker.addEventListener("statechange", changed);
    changed();
  });
}

/** The server has already revoked the session; clean up the browser's remaining capability. */
export async function clearBrowserPush(): Promise<void> {
  const registration = await browserPushRegistration();
  if (!registration) return;
  await (await registration.pushManager.getSubscription())?.unsubscribe();
  for (const notification of await registration.getNotifications({ tag: "mytuums-inbox" }))
    notification.close();
}
