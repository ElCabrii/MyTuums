import { atom } from "jotai";
import { atomWithReset, RESET } from "jotai/utils";
import { queryClientAtom } from "jotai-tanstack-query";
import { BIO_MAX_LENGTH, type ImageKind } from "@my-tuums/api/constants";
import { authClient } from "@/lib/auth-client";
import { client, orpc } from "@/lib/orpc";
import { createDisplayVariant, ImageError } from "@/lib/media";
import { refreshSession } from "@/lib/session-sync";
import { validateBio, validateDisplayName } from "@/lib/auth-validation";
import { authErrorAtom, authPendingAtom } from "@/atoms/auth";
import { viewerAtom, viewerHandleAtom } from "@/atoms/session";
import { m } from "@/paraglide/messages.js";

/**
 * The editable-profile drafts, with the same lifetime rule as every other form
 * in this app: module-scoped atoms reset on unmount, never a nested
 * `<Provider>` (see the long comment in `atoms/auth-form.ts` for why that
 * would resolve session reads against an empty store).
 *
 * Unlike the auth forms these start out *populated* from the session rather
 * than empty — an edit form pre-filled with what you already have. That is
 * what `hydrateProfileEditAtom` below is for; it cannot be a derived atom,
 * because a derived value would overwrite what the person is typing every time
 * the session refetched.
 */
export const profileNameDraftAtom = atomWithReset("");
export const profileBioDraftAtom = atomWithReset("");

/** First violated rule across the two fields, or null. */
export const profileEditValidationAtom = atom((get) => {
  return validateDisplayName(get(profileNameDraftAtom)) ?? validateBio(get(profileBioDraftAtom));
});

/** Characters left in the bio, for the counter under the field. */
export const bioRemainingAtom = atom(
  (get) => BIO_MAX_LENGTH - get(profileBioDraftAtom).length,
);

/**
 * Which image slot has an upload in flight, or null.
 *
 * Its own atom rather than reusing `authPendingAtom`, because the avatar and
 * the banner are independently uploadable and a single shared flag would grey
 * out both buttons — and, worse, would make the spinner appear on the control
 * the person did not touch.
 */
export const imageUploadingAtom = atom<ImageKind | null>(null);

export const resetProfileEditAtom = atom(null, (_get, set) => {
  set(profileNameDraftAtom, RESET);
  set(profileBioDraftAtom, RESET);
  set(imageUploadingAtom, null);
  set(authErrorAtom, null);
});

/** Fills the drafts from the current session. Called when the form mounts. */
export const hydrateProfileEditAtom = atom(null, (get, set) => {
  const viewer = get(viewerAtom);
  set(profileNameDraftAtom, viewer?.name ?? "");
  set(profileBioDraftAtom, viewer?.bio ?? "");
});

/**
 * Drops the cached `user.byUsername` entry for the signed-in person.
 *
 * Necessary because none of these writes go through the oRPC mutation layer:
 * the profile page reads a *query*, and nothing invalidates it when the session
 * user changes. Without this, saving a bio updates the header (which reads the
 * session) while the profile page underneath keeps rendering the old one until
 * something else happens to refetch.
 *
 * Keyed by the normalised handle, which is what `profileAtomFamily` is keyed by
 * and what `handleOf` guarantees — using `displayUsername` here would build a
 * key that matches nothing when the two differ in casing.
 *
 * A write-only atom rather than a plain function so it can reach
 * `queryClientAtom` through the store, which is the only place the app's single
 * `QueryClient` is addressable (see `lib/store.ts`).
 */
const invalidateOwnProfileAtom = atom(null, (get) => {
  const handle = get(viewerHandleAtom);
  if (!handle) return;

  void get(queryClientAtom).invalidateQueries({
    queryKey: orpc.user.byUsername.key({ input: { username: handle } }),
  });
});

/**
 * Saves the display name and bio.
 *
 * Goes through `authClient.updateUser` rather than an oRPC procedure on
 * purpose: these are Better Auth user fields, and routing them through the auth
 * client is what makes `packages/auth/src/profile.ts`'s database hook the
 * single enforcement point for their rules. An oRPC procedure writing them with
 * Drizzle would bypass that hook entirely — which is exactly the property the
 * image upload relies on, and exactly the property these must NOT have.
 */
export const saveProfileAtom = atom(null, async (get, set): Promise<boolean> => {
  const validationError = get(profileEditValidationAtom);
  if (validationError) {
    set(authErrorAtom, validationError);
    return false;
  }

  set(authErrorAtom, null);
  set(authPendingAtom, true);
  try {
    const res = await authClient.updateUser({
      name: get(profileNameDraftAtom).trim(),
      // Empty means "no bio", stored as null rather than "" so the profile page
      // can test the field rather than its length. The cast is the same client-
      // type boundary `atoms/handle-claim.ts` documents: the server accepts
      // these additionalFields, 1.6.25's client types don't surface them.
      ...({ bio: get(profileBioDraftAtom).trim() || null } as Record<string, string | null>),
    });

    if (res.error) {
      set(authErrorAtom, res.error.message || m.common_something_went_wrong());
      return false;
    }

    set(invalidateOwnProfileAtom);
    return true;
  } catch (err) {
    console.error("Profile save error:", err);
    set(authErrorAtom, m.common_something_went_wrong());
    return false;
  } finally {
    set(authPendingAtom, false);
  }
});

/**
 * Makes the display variant and uploads one image slot — the original file
 * untouched, the variant alongside it (see `lib/media.ts` for why the upload
 * carries both).
 *
 * The upload procedure writes the user row itself, past Better Auth, so the
 * session the client holds is stale the moment this resolves — hence
 * `refreshSession()` rather than the `waitFor*` helpers, which only outlast a
 * refetch something else already started. The refresh is also what brings the
 * new `imageOriginal`/`bannerImageOriginal` into the session for the future
 * crop editor.
 */
export const uploadImageAtom = atom(
  null,
  async (_get, set, { kind, file }: { kind: ImageKind; file: File }): Promise<boolean> => {
    set(authErrorAtom, null);
    set(imageUploadingAtom, kind);
    try {
      const display = await createDisplayVariant(file, kind);
      await client.user.uploadImage({ kind, original: file, display });

      await refreshSession();
      set(invalidateOwnProfileAtom);
      return true;
    } catch (err) {
      set(authErrorAtom, messageForUploadError(err));
      return false;
    } finally {
      set(imageUploadingAtom, null);
    }
  },
);

export const removeImageAtom = atom(
  null,
  async (_get, set, kind: ImageKind): Promise<boolean> => {
    set(authErrorAtom, null);
    set(imageUploadingAtom, kind);
    try {
      await client.user.removeImage({ kind });

      await refreshSession();
      set(invalidateOwnProfileAtom);
      return true;
    } catch (err) {
      set(authErrorAtom, messageForUploadError(err));
      return false;
    } finally {
      set(imageUploadingAtom, null);
    }
  },
);

/**
 * Turns whatever went wrong into copy.
 *
 * `ImageError` is the client's own refusal (wrong type, too big, undecodable)
 * and gets a specific message. Anything else came off the wire, where the
 * server's English rejection strings are already what
 * `lib/auth-error-message.ts` knows how to translate — so it is passed through
 * rather than flattened, exactly as that module's pass-through rule requires.
 */
function messageForUploadError(err: unknown): string {
  if (err instanceof ImageError) {
    if (err.problem === "size") return m.validation_image_too_large();
    if (err.problem === "type") return m.validation_image_type();
    return m.validation_image_unreadable();
  }

  console.error("Image upload error:", err);
  return err instanceof Error && err.message ? err.message : m.common_something_went_wrong();
}
