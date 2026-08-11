import { describe, expect, it } from "vitest";
import {
  MANAGED_IMAGE_MESSAGE,
  validateProfileFieldsOnCreateHook,
  validateProfileFieldsOnUpdateHook,
} from "@my-tuums/auth/profile";

describe("profile image lifecycle validation", () => {
  it("accepts a provider HTTPS image when a user is created", async () => {
    await expect(
      validateProfileFieldsOnCreateHook({
        image: "https://avatars.example.test/alice.png",
        bannerImage: "https://cdn.example.test/alice-banner.jpg",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects remote image URLs and cross-user media paths on ordinary updates", () => {
    expect(() =>
      validateProfileFieldsOnUpdateHook({ image: "https://tracker.example.test/pixel.gif" }),
    ).toThrow(MANAGED_IMAGE_MESSAGE);

    expect(() =>
      validateProfileFieldsOnUpdateHook({ bannerImage: "https://tracker.example.test/banner.gif" }),
    ).toThrow(MANAGED_IMAGE_MESSAGE);

    expect(() =>
      validateProfileFieldsOnUpdateHook({ image: "/media/avatars/someone-else/key.webp" }),
    ).toThrow(MANAGED_IMAGE_MESSAGE);
  });

  it("keeps absent, blank, and unrelated partial updates valid", async () => {
    await expect(
      validateProfileFieldsOnUpdateHook({ bio: "A short bio", themePreference: "dark" }),
    ).resolves.toBeUndefined();
    await expect(
      validateProfileFieldsOnUpdateHook({ image: "", bannerImage: null }),
    ).resolves.toBeUndefined();
    await expect(
      validateProfileFieldsOnUpdateHook({ localePreference: "fr" }),
    ).resolves.toBeUndefined();
  });
});
