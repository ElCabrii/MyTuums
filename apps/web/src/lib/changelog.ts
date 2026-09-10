import { z } from "zod";

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export const appVersionSchema = z.string().regex(VERSION_PATTERN);

type VersionParts = readonly [major: number, minor: number, patch: number];

function parseVersion(version: string): VersionParts | null {
  const match = VERSION_PATTERN.exec(version);
  if (!match) return null;

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Returns whether `candidate` is a valid release newer than `seen`. */
export function isNewerAppVersion(candidate: string, seen: string | null): boolean {
  const candidateParts = parseVersion(candidate);
  if (!candidateParts) return false;
  if (seen === null) return true;

  const seenParts = parseVersion(seen);
  if (!seenParts) return true;

  for (let index = 0; index < candidateParts.length; index += 1) {
    const candidatePart = candidateParts[index];
    const seenPart = seenParts[index];
    if (candidatePart === seenPart) continue;
    return candidatePart > seenPart;
  }

  return false;
}

export function shouldShowChangelog({
  appVersion,
  seenVersion,
  hasContent,
}: {
  appVersion: string;
  seenVersion: string | null;
  hasContent: boolean;
}): boolean {
  return hasContent && isNewerAppVersion(appVersion, seenVersion);
}
