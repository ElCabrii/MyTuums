import type { ReactNode } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type AnyRoute,
} from "@tanstack/react-router";

/**
 * A minimal stand-in for `routeTree.gen.ts`, covering every path a component
 * under test can `<Link>` or `navigate()` to. The component under test is
 * mounted inside the root route's component, next to an `<Outlet/>` — one
 * render, kept mounted through every navigation a test triggers, exactly
 * like `__root.tsx` keeps Header/Footer mounted while only the routed page
 * changes underneath. That gives a test two independent ways to confirm a
 * navigation happened: `router.state.location.pathname`, or the target
 * route's marker appearing via the outlet.
 *
 * The stub tree is a second source of truth for routing, so it is asserted
 * against the real route files at module load: a new page that forgets to add
 * its path here fails with a message naming the missing route, instead of
 * surfacing later as an unrelated `<Link>` blowing up in some other test.
 */

/**
 * The full paths the real app routes declare, read from `src/routes/*.tsx`'s
 * `createFileRoute("<path>")` calls. These files are the source of truth the
 * Vite plugin generates `routeTree.gen.ts` from, and — unlike that
 * git-ignored artefact — they are always present, so the assertion runs in
 * the unit job without a prior build.
 */
const routeFiles = import.meta.glob<string>("../routes/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});

const REAL_FULL_PATHS = new Set<string>();
for (const source of Object.values(routeFiles)) {
  for (const match of source.matchAll(/createFileRoute\("([^"]+)"\)/g)) {
    REAL_FULL_PATHS.add(match[1]);
  }
}

function collectFullPaths(route: AnyRoute, into: Set<string>): void {
  // SAFETY: `AnyRoute` erases the concrete fullPath type to `any`; the value is
  // a string at runtime (the router joins parent path + path), so the cast
  // only restores what the erased generic already guarantees.
  into.add(route.fullPath as string);
  // SAFETY: `AnyRoute` erases the concrete children element type; every child
  // is itself a route, so recursing with the erased `AnyRoute` is sound.
  const children = route.children as AnyRoute[] | undefined;
  for (const child of children ?? []) {
    collectFullPaths(child, into);
  }
}

function createTestRouteTree(ui: ReactNode) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        {ui}
        <Outlet />
      </>
    ),
  });

  const stubRoute = (path: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => <p>Stub route: {path}</p>,
    });

  // The real profile is a layout plus an index child. Both route ids are
  // consumed through getRouteApi(), by ProfileLayout and ProfilePosts
  // respectively, so a single flat stub cannot satisfy both components.
  const profileRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/@{$username}",
    component: () => (
      <>
        <p>Stub route: /@{"{$username}"}</p>
        <Outlet />
      </>
    ),
  });
  const profileIndexRoute = createRoute({
    getParentRoute: () => profileRoute,
    path: "/",
    component: () => <p>Stub route: /@{"{$username}"}/</p>,
  });

  return rootRoute.addChildren([
    stubRoute("/"),
    stubRoute("/login"),
    stubRoute("/register"),
    // The banned-account screen (issue #74) — a signed-in-gate exemption like
    // the legal pages below, so navigate-on-BANNED_USER tests can land here.
    stubRoute("/banned"),
    // Signed-in-gate exemptions like the legal pages below — tests for the
    // gate need them reachable without a redirect.
    stubRoute("/forgot-password"),
    stubRoute("/reset-password"),
    stubRoute("/discover"),
    // search-page.test.tsx navigates the real `SearchPage` between `/search`
    // and `/search?q=...` — `getRouteApi("/search")` needs the route to
    // exist in the tree even though the stub never renders it (the page is
    // mounted directly as `ui`, like the not-found-page test).
    stubRoute("/search"),
    stubRoute("/post/$postId"),
    // Moderation targets (moderation-page.test.tsx, appeal-page.test.tsx):
    // `AppealPage` reads `getRouteApi("/appeal").useSearch()` the same way
    // `SearchPage` reads `/search`'s, so the route has to exist in the tree
    // even though the stub never renders it — the real component is mounted
    // directly as `ui`.
    stubRoute("/moderation"),
    stubRoute("/appeal"),
    // The legal pages are signed-in-gate exemptions — tests for the gate
    // need them reachable without a redirect.
    stubRoute("/privacy"),
    stubRoute("/terms"),
    stubRoute("/mentions-legales"),
    // Literal-prefix syntax — kept byte-identical to src/routes/@{$username}.tsx.
    profileRoute.addChildren([profileIndexRoute]),
    // Header-test targets: the account menu's View profile / Settings items
    // and the handle-less avatar's /welcome link (header.test.tsx).
    stubRoute("/welcome"),
    stubRoute("/settings/account"),
    // two-factor.test.tsx mounts the real challenge page as `ui` — the route
    // has to exist in the tree for `Route.useSearch()` to resolve, same as
    // `/search` and `/appeal` above.
    stubRoute("/two-factor"),
  ]);
}

export function buildTestRouter(ui: ReactNode, initialPath: string) {
  const router = createRouter({
    routeTree: createTestRouteTree(ui),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  // Assert the stub tree covers every real route. A new page that forgets to
  // add its path here fails with the missing route named, rather than inside
  // an unrelated `<Link>` in some other test. `fullPath` is only populated
  // once the router has initialised its route tree, so this runs after
  // `createRouter` rather than inside `createTestRouteTree`.
  const stubPaths = new Set<string>();
  collectFullPaths(router.routeTree, stubPaths);
  const missing = [...REAL_FULL_PATHS].filter((path) => !stubPaths.has(path));
  if (missing.length > 0) {
    throw new Error(
      `The test route tree in src/test/route-tree.tsx is missing routes that exist in src/routes/. ` +
        `Add a stub for each so a component under test can <Link> or navigate() to it:\n` +
        missing.map((path) => `  - ${path}`).join("\n"),
    );
  }

  return router;
}

export { RouterProvider };
