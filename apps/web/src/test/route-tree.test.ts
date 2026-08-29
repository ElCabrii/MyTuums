import { describe, expect, it } from "vitest";
import { diffRouteTree, REAL_ROUTE_FULL_PATHS, stubRouteFullPaths } from "@/test/route-tree";

/**
 * `diffRouteTree` is what turns "the stub tree drifted from `src/routes/`"
 * into a named failure in both directions. One test, both directions at once:
 * the per-direction cases were the same set difference three more times.
 */
describe("diffRouteTree", () => {
  it("names missing stubs and stale stubs together, sorted deterministically", () => {
    const real = ["/", "/login", "/register", "/settings/account"];
    const stub = ["/", "/login", "/old-page", "/legacy"];

    expect(diffRouteTree(real, stub)).toEqual({
      missing: ["/register", "/settings/account"],
      stale: ["/legacy", "/old-page"],
    });
  });

  it("reports nothing when they match exactly", () => {
    const routes = ["/", "/login", "/@{$username}", "/post/$postId"];

    expect(diffRouteTree(routes, [...routes])).toEqual({ missing: [], stale: [] });
  });
});

/**
 * The canonical owner of "the test stub tree and the real route files agree".
 * This is the one place the invariant is asserted: a new page that forgets
 * its stub fails here with the missing route named, and a page deleted or
 * renamed while its stub lingered fails with the stale stub named.
 * `buildTestRouter` deliberately does not re-check it on every call.
 */
describe("test route inventory", () => {
  it("covers every route in src/routes/, and only those", () => {
    const { missing, stale } = diffRouteTree(REAL_ROUTE_FULL_PATHS, stubRouteFullPaths());

    expect(missing, "real routes with no stub in src/test/route-tree.tsx").toEqual([]);
    expect(stale, "stubs with no real route in src/routes/").toEqual([]);
  });
});

/**
 * SAFETY: the glob hands back modules of unknown shape; every real route file
 * (minus the root, excluded below) exports `Route` from `createFileRoute`, so
 * this structural view is all the test needs — the value at runtime is the
 * constructed route with its authored options.
 */
interface RoutableModule {
  Route?: {
    options?: {
      head?: (ctx: { params: Record<string, string> }) => {
        links?: Array<Record<string, string>>;
      };
    };
  };
}

const realRouteModules = import.meta.glob<unknown>("../routes/*.tsx");

/**
 * Every canonical `<link>` on a rendered page comes from the matched route's
 * own `head` (via `pageHead`); the root's `fallbackHead` deliberately supplies
 * none, so a hand-rolled route head can silently duplicate it or drop it
 * without any other test noticing. This is the one place that calls each real
 * head function and pins "exactly one" — issue #238's regression guard.
 *
 * Routes that declare no `head` are skipped, not failed: the profile index
 * (`/@{$username}/`) legitimately inherits its parent layout's head, and the
 * root itself is skipped for the opposite reason — its `fallbackHead` must
 * stay link-free or it would double the canonical wherever the router keeps
 * both matches' links.
 */
describe("real route heads", () => {
  it("emits exactly one canonical link from every route that declares a head", async () => {
    for (const [file, load] of Object.entries(realRouteModules)) {
      if (file.endsWith(".test.tsx")) continue;
      // The root's fallbackHead intentionally has no `links` (see
      // `fallbackHead` in lib/document-head.ts).
      if (file.endsWith("__root.tsx")) continue;

      // SAFETY: the glob only covers src/routes/*.tsx, and every non-test
      // file there exports `Route` from `createFileRoute`; the structural
      // view above merely restores that known shape after `unknown`.
      const { Route } = (await load()) as RoutableModule;
      const head = Route?.options?.head;
      if (!head) continue;

      const canonicals = (head({ params: {} }).links ?? []).filter(
        (link) => link.rel === "canonical",
      );
      expect(canonicals, `head() emitted by ${file}`).toHaveLength(1);
    }
  });
});
