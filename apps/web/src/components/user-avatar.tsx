import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { MEDIA_URL_PREFIX, MEDIA_VARIANT_WIDTHS, mediaVariantPath } from "@my-tuums/api/constants";
import { initialsOf } from "@/lib/user";
import { cn } from "@/lib/utils";

/**
 * The narrowest shape an avatar needs. Deliberately structural rather than one
 * of the generated oRPC types: the same component renders a `Profile`, a
 * `UserSummary`, a post's embedded author and the session user, and none of
 * those four are the same type.
 */
export interface AvatarUser {
  name?: string | null;
  image?: string | null;
}

interface UserAvatarProps {
  user: AvatarUser | null | undefined;
  /** Sizing and any per-site decoration. */
  className?: string;
  /** Applied to the initials, which need their own type scale at large sizes. */
  fallbackClassName?: string;
  /**
   * Overrides the alt text. Defaults to the display name, which is right
   * everywhere the avatar is the only thing identifying the person.
   */
  alt?: string;
  /** Reports whether the underlying image loaded so callers can change affordances. */
  onImageLoadingStatusChange?: (status: "idle" | "loading" | "loaded" | "error") => void;
}

/**
 * The responsive sources for OUR avatars (`/media/avatars/…`): a 96 px
 * variant for the feed chrome sizes and a 256 px one for the profile header,
 * both at 2x DPR — generated on demand by the server (see `media-variants.ts`
 * in `@my-tuums/api`). An OAuth provider's absolute avatar URL returns
 * `undefined`, and the single `src` stands alone exactly as before — that is
 * also the graceful path for any non-avatar media path.
 */
function avatarSrcSet(image: string | null | undefined): string | undefined {
  if (!image?.startsWith(MEDIA_URL_PREFIX)) return undefined;
  return MEDIA_VARIANT_WIDTHS.avatars
    .map((width) => `${mediaVariantPath(image, width)} ${width}w`)
    .join(", ");
}

/**
 * One avatar, rendered the same way everywhere.
 *
 * This existed as five hand-copied `Avatar`/`AvatarImage`/`AvatarFallback`
 * triples — header, composer, post card, user list and the profile page — all
 * structurally identical and all repeating `image || undefined` and
 * `initialsOf(name)`. That was survivable while `user.image` was only ever
 * written by an OAuth provider at sign-up. Now that it is editable, every one of
 * those five had to learn the same new behaviour at once, which is the point at
 * which five copies stops being cheaper than one component.
 *
 * The `|| undefined` is not incidental: `AvatarImage` treats an empty string as
 * a source and renders a broken image rather than falling back to the initials.
 */
export function UserAvatar({
  user,
  className,
  fallbackClassName,
  alt,
  onImageLoadingStatusChange,
}: UserAvatarProps) {
  const displayName = user?.name ?? null;
  // `sizes` is the srcset's other half: without it a browser assumes 100vw
  // and over-downloads for what is usually a 40 px disc. The profile header
  // is the largest avatar this app draws (~128 px), so every call site is
  // covered by the 96/256 pair within it.
  const src = user?.image || undefined;

  return (
    <Avatar className={className}>
      <AvatarImage
        src={src}
        srcSet={avatarSrcSet(user?.image)}
        sizes="128px"
        alt={alt ?? displayName ?? ""}
        onLoadingStatusChange={onImageLoadingStatusChange}
      />
      {/* `text-foreground`, not the primitive's `text-muted-foreground`: that
          default measures 4.39:1 on its own `bg-muted` disc, which fails WCAG
          AA for the initials at every size this app draws an avatar. Sites
          with their own pair (the header's primary-filled disc) still win —
          `fallbackClassName` is merged last. */}
      <AvatarFallback className={cn("text-foreground font-semibold", fallbackClassName)}>
        {initialsOf(displayName)}
      </AvatarFallback>
    </Avatar>
  );
}
