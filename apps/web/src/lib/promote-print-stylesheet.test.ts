import { afterEach, describe, expect, it } from "vitest";
import { promotePrintStylesheet } from "./promote-print-stylesheet";

afterEach(() => {
  document.head.innerHTML = "";
});

describe("promotePrintStylesheet", () => {
  it("promotes a stylesheet still stuck at media=print", () => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.media = "print";
    document.head.appendChild(link);

    promotePrintStylesheet();

    expect(link.media).toBe("all");
  });

  it("leaves a stylesheet whose onload already promoted it alone", () => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.media = "all";
    document.head.appendChild(link);

    promotePrintStylesheet();

    expect(link.media).toBe("all");
  });

  it("does nothing when there is no stylesheet at all", () => {
    expect(() => promotePrintStylesheet()).not.toThrow();
  });

  it("only touches stylesheet links, not an unrelated print-media link", () => {
    const link = document.createElement("link");
    link.rel = "preload";
    link.media = "print";
    document.head.appendChild(link);

    promotePrintStylesheet();

    expect(link.media).toBe("print");
  });
});
