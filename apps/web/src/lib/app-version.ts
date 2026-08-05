export type AppStage = "alpha" | "beta" | null;

/**
 * Which stage label a version earns, from the semver-ish "major.minor.patch"
 * string that `define` inlines from package.json at build time.
 *
 * Ranges: below 0.5 is "alpha", 0.5 up to (not including) 1.0 is "beta",
 * anything at or past 1.0 is stable and gets no tag. A string that does not
 * start with "major.minor" parses to `null` too — if the version ever stops
 * being semver-ish, the tag disappears rather than lying.
 *
 * Only major.minor matter; a prerelease suffix like "0.5.0-beta.1" is
 * ignored, which is what makes the numeric comparison well-defined.
 */
export function appStage(version: string): AppStage {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major >= 1) return null;
  return minor < 5 ? "alpha" : "beta";
}

/** The version string baked into this bundle (see vite.config.ts `define`). */
export const APP_VERSION: string = __APP_VERSION__;

/** The header tag for this build: "alpha", "beta", or nothing when stable. */
export const APP_STAGE: AppStage = appStage(APP_VERSION);
