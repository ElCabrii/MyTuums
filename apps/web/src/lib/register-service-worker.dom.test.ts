import { describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "./register-service-worker";

describe("registerServiceWorker", () => {
  it("does nothing outside a production build", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");

    registerServiceWorker();

    expect(addEventListener).not.toHaveBeenCalled();
  });
});
