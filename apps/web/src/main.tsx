import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { Provider } from "jotai";
import { queryClient } from "@/lib/query-client";
import { store } from "@/lib/store";
import { promotePrintStylesheet } from "@/lib/promote-print-stylesheet";
import { registerServiceWorker } from "@/lib/register-service-worker";
import { routeTree } from "./routeTree.gen";

// Boot-time fallback for the non-blocking stylesheet trick — see the
// function's own doc comment for why this cannot be left to the `onload`
// handler alone. A plain call, not an atom or effect: this runs once, before
// React even mounts, on a `document` global no store or component owns.
promotePrintStylesheet();
registerServiceWorker();

// The single router for the app, built from the Vite-generated route tree.
const router = createRouter({ routeTree });

// Registers the router's generated types (routeTree.gen.ts) with TanStack
// Router, which is what makes typed navigation, params and search resolve
// in every file.
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </Provider>
  </React.StrictMode>,
);
