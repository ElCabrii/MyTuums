import { expect, it, vi } from "vitest";
import { preparePostAttachments, writePostAttachments } from "./post-media.js";

it("preserves the upload failure when cleanup also fails without logging provider secrets or media keys", async () => {
  const prepared = preparePostAttachments("private-author", "private-post", [
    { bytes: new Uint8Array([1]), type: "image/png", width: 1, height: 1 },
  ]);
  const uploadFailure = new Error("synthetic upload failure");
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(
      writePostAttachments(
        {
          put: () => Promise.reject(uploadFailure),
          remove: (key) => Promise.reject(new Error(`synthetic-provider-secret ${key}`)),
          head: () => Promise.resolve(null),
          get: () => Promise.resolve(null),
        },
        prepared,
      ),
    ).rejects.toBe(uploadFailure);
    expect(errorLog.mock.calls.length).toBeGreaterThan(0);
    for (const entry of errorLog.mock.calls) {
      expect(entry).toEqual([{ event: "post_attachment_cleanup_deferred" }]);
    }
  } finally {
    errorLog.mockRestore();
  }
});
