import { describe, expect, it } from "vitest";
import { diffRouteTree } from "@/test/route-tree";

describe("diffRouteTree", () => {
  it("reports nothing when the real routes and stubs match exactly", () => {
    const real = ["/", "/login", "/@{$username}", "/@{$username}/", "/post/$postId"];
    const stub = ["/", "/login", "/@{$username}", "/@{$username}/", "/post/$postId"];

    expect(diffRouteTree(real, stub)).toEqual({ missing: [], stale: [] });
  });

  it("reports a real route that has no stub", () => {
    const real = ["/", "/login", "/register"];
    const stub = ["/", "/login"];

    expect(diffRouteTree(real, stub)).toEqual({ missing: ["/register"], stale: [] });
  });

  it("reports a stale stub whose real route was deleted or renamed", () => {
    const real = ["/", "/login"];
    const stub = ["/", "/login", "/old-page"];

    expect(diffRouteTree(real, stub)).toEqual({ missing: [], stale: ["/old-page"] });
  });

  it("reports both directions at once, sorted deterministically", () => {
    const real = ["/", "/login", "/register", "/settings/account"];
    const stub = ["/", "/login", "/old-page", "/legacy"];

    expect(diffRouteTree(real, stub)).toEqual({
      missing: ["/register", "/settings/account"],
      stale: ["/legacy", "/old-page"],
    });
  });
});
