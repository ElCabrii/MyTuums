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
