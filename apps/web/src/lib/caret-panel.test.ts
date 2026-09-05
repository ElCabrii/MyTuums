import { describe, expect, it } from "vitest";
import { caretPanelPlacement } from "@/lib/caret-panel";

/**
 * The caret-panel placement math (issue #336): below is home, above is the
 * flip, and a panel that fits nowhere stays below rather than covering the
 * line just typed.
 */
describe("caretPanelPlacement", () => {
  it("opens below the caret line when the panel fits the viewport", () => {
    const placement = caretPanelPlacement({
      caretTop: 40,
      lineHeight: 20,
      gap: 8,
      panelHeight: 200,
      caretViewportBottom: 300,
      viewportHeight: 800,
    });

    expect(placement).toEqual({ side: "below", top: 68 });
  });

  it("treats exactly filling the remaining viewport as fitting below", () => {
    const placement = caretPanelPlacement({
      caretTop: 40,
      lineHeight: 20,
      gap: 8,
      panelHeight: 200,
      caretViewportBottom: 592,
      viewportHeight: 800,
    });

    expect(placement.side).toBe("below");
  });

  it("flips above the caret line when below overflows but above fits", () => {
    const placement = caretPanelPlacement({
      caretTop: 600,
      lineHeight: 20,
      gap: 8,
      panelHeight: 200,
      caretViewportBottom: 700,
      viewportHeight: 800,
    });

    expect(placement).toEqual({ side: "above", top: 392 });
  });

  it("stays below when the panel fits on neither side", () => {
    const placement = caretPanelPlacement({
      caretTop: 100,
      lineHeight: 20,
      gap: 8,
      panelHeight: 700,
      caretViewportBottom: 300,
      viewportHeight: 800,
    });

    expect(placement).toEqual({ side: "below", top: 128 });
  });
});
