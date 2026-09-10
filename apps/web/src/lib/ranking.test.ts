import { describe, expect, it } from "vitest";
import { ORPCError } from "@orpc/client";
import { getFeedRanking, getPageRanking, isSnapshotExpiredError } from "@/lib/ranking";
import { makePost, makePostListPage, makeRanking, makeRankSuggestion } from "@/test/factories";

describe("getPageRanking", () => {
  it("returns undefined for a chronological page carrying ranking null", () => {
    expect(getPageRanking(makePostListPage({ items: [makePost()] }))).toBeUndefined();
  });

  it("returns the snapshot block a ranked page carries", () => {
    const ranking = makeRanking({ snapshotId: "snapshot-1" });
    expect(getPageRanking(makePostListPage({ ranking }))?.snapshotId).toBe("snapshot-1");
  });
});

describe("getFeedRanking", () => {
  it("returns the first page that carries ranking metadata", () => {
    const pages = [
      makePostListPage({ items: [makePost()], nextCursor: "cursor-1" }),
      makePostListPage({ ranking: makeRanking({ snapshotId: "snapshot-1" }) }),
    ];
    expect(getFeedRanking(pages)?.snapshotId).toBe("snapshot-1");
  });

  it("returns undefined when no page carries ranking metadata", () => {
    expect(getFeedRanking([makePostListPage({ items: [makePost()] })])).toBeUndefined();
  });

  it("surfaces suggestion rows for the Who-to-Follow module", () => {
    const pages = [
      makePostListPage({
        ranking: makeRanking({ suggestions: [makeRankSuggestion({ id: "user-1" })] }),
      }),
    ];
    expect(getFeedRanking(pages)?.suggestions.map((item) => item.id)).toEqual(["user-1"]);
  });
});

describe("isSnapshotExpiredError", () => {
  it("matches the invalid-ranking resume refusal", () => {
    expect(
      isSnapshotExpiredError(
        new ORPCError("BAD_REQUEST", {
          message: "This ranking is no longer valid. Refresh the feed to build a new one.",
        }),
      ),
    ).toBe(true);
  });

  it("does not treat unrelated ranking validation as snapshot expiry", () => {
    expect(
      isSnapshotExpiredError(
        new ORPCError("BAD_REQUEST", {
          message: "Ranked feeds cannot be combined with scoping filters.",
        }),
      ),
    ).toBe(false);
  });

  it("ignores an ordinary BAD_REQUEST that names no ranking", () => {
    expect(isSnapshotExpiredError(new ORPCError("BAD_REQUEST", { message: "Bad input." }))).toBe(
      false,
    );
  });

  it("ignores server errors and transport failures", () => {
    expect(
      isSnapshotExpiredError(new ORPCError("INTERNAL_SERVER_ERROR", { message: "Down." })),
    ).toBe(false);
    expect(isSnapshotExpiredError(new Error("network down"))).toBe(false);
    expect(isSnapshotExpiredError(null)).toBe(false);
  });
});
