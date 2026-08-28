import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod";
import { jsonStorage } from "@/lib/json-storage";

const STORAGE_KEY = "my-tuums.avatar-upgrade-dismissed";

const dismissalSchema = z.string().min(1);

/**
 * The raw persisted value. Typed `unknown` on purpose, same as
 * `feedScopeAtom` in `lib/feed-scope.ts`: `localStorage` is user-editable and
 * outlives deploys, so nothing read back out of it is trustworthy —
 * `avatarUpgradeDismissalAtom` below is the only sanctioned way in.
 *
 * `getOnInit` matters for the same reason it does there: without it the first
 * read yields the default and the stored value only afterwards, which would
 * flash the prompt for one frame on a visit where it was already dismissed.
 */
const storedDismissalAtom = atomWithStorage<unknown>(STORAGE_KEY, null, jsonStorage(), {
  getOnInit: true,
});

/**
 * The display URL whose upgrade prompt the person dismissed on this device.
 *
 * The value is the avatar's display path, not the user id, so a dismissal is
 * scoped to the avatar it was about: a new upload produces a new path and the
 * prompt re-evaluates from the fresh measurement (a >= ceiling variant never
 * prompts at all), while dismissing twice for the same picture stays quiet.
 * It is per-browser state, like the theme and feed-scope choices — re-prompting
 * on another device after an explicit dismiss is the accepted trade for not
 * inventing server state (issue #246).
 *
 * Reads collapse anything unrecognised to `null` (a hand-edited key, or a
 * value from a future version of the app) so a corrupt entry can only cause a
 * prompt, never suppress one; writes are typed, so only a URL or a reset is
 * ever stored.
 */
export const avatarUpgradeDismissalAtom = atom(
  (get): string | null => {
    const parsed = dismissalSchema.safeParse(get(storedDismissalAtom));
    return parsed.success ? parsed.data : null;
  },
  (_get, set, next: string | null) => {
    set(storedDismissalAtom, next);
  },
);
