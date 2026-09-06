import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { appVersionSchema } from "@/lib/changelog";
import { jsonStorage } from "@/lib/json-storage";

const STORAGE_KEY = "my-tuums.seen-changelog-version";

/** User-editable per-device state; the public atom below is the sanitised seam. */
const storedSeenChangelogVersionAtom = atomWithStorage<unknown>(STORAGE_KEY, null, jsonStorage(), {
  getOnInit: true,
});

export const seenChangelogVersionAtom = atom(
  (get): string | null => {
    const parsed = appVersionSchema.safeParse(get(storedSeenChangelogVersionAtom));
    return parsed.success ? parsed.data : null;
  },
  (_get, set, version: string) => {
    const parsed = appVersionSchema.safeParse(version);
    if (parsed.success) set(storedSeenChangelogVersionAtom, parsed.data);
  },
);
