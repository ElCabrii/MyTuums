import { Gamepad2 } from "lucide-react";
import { MEDIA_URL_PREFIX, MEDIA_VARIANT_WIDTHS, mediaVariantPath } from "@my-tuums/api/constants";
import { cn } from "@/lib/utils";

/**
 * One game cover, rendered the same way everywhere the directory shows one —
 * the grid card, the page header, the profile rail (stage 3). Portrait
 * aspect: IGDB covers are 2:3, and the object-cover crop keeps a slightly
 * off-spec source from stretching.
 *
 * `sizes` is a prop because the same component renders at grid (~160px) and
 * page (~320px) widths; the srcSet itself is fixed — the two widths the
 * server derives for the `games/` prefix and no others.
 */
export function GameCover({
  cover,
  name,
  className,
  fallbackClassName,
  sizes,
}: {
  cover: string | null;
  name: string;
  className?: string;
  fallbackClassName?: string;
  sizes: string;
}) {
  if (!cover) {
    return (
      <div
        role="img"
        aria-label={name}
        className={cn(
          "bg-muted text-muted-foreground flex h-full w-full items-center justify-center",
          className,
        )}
      >
        <Gamepad2 className={fallbackClassName ?? "h-8 w-8"} aria-hidden />
      </div>
    );
  }

  // A cover is always our own re-hosted `/media/games/…` object (the sync
  // and the seeder are the only writers), so a non-media path is not a real
  // case — but answering it the same way `UserAvatar` answers a foreign
  // avatar URL keeps the component total.
  const srcSet = cover.startsWith(MEDIA_URL_PREFIX)
    ? MEDIA_VARIANT_WIDTHS.games
        .map((width) => `${mediaVariantPath(cover, width)} ${width}w`)
        .join(", ")
    : undefined;

  return (
    <img
      src={cover}
      srcSet={srcSet}
      sizes={sizes}
      alt={name}
      loading="lazy"
      decoding="async"
      className={cn("h-full w-full object-cover", className)}
    />
  );
}
