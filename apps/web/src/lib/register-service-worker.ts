/** Registers the production-only offline shell after the initial page load. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;

  window.addEventListener(
    "load",
    () => {
      // Registration failure must not prevent the online app from booting.
      void navigator.serviceWorker.register("/service-worker.js").catch(() => undefined);
    },
    { once: true },
  );
}
