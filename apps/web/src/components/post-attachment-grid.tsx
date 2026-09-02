import { ImageViewer } from "@/components/image-viewer";
import { MEDIA_VARIANT_WIDTHS, mediaVariantPath } from "@my-tuums/api/constants";
import { m } from "@/paraglide/messages.js";

export interface PostAttachmentView {
  id: string;
  url: string;
  position: number;
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
}

/**
 * Builds the `srcset` for one attachment: every derivable variant narrower
 * than the original, then the original itself — the last resort that also
 * covers a client that ignores `srcset` entirely. The server generates a
 * variant on its first request (see `media-variants.ts` in
 * `@my-tuums/api`), so every URL here resolves.
 */
function attachmentSrcSet(attachment: PostAttachmentView): string | undefined {
  const variants = MEDIA_VARIANT_WIDTHS.posts
    .filter((width) => width < attachment.width)
    .map((width) => `${mediaVariantPath(attachment.url, width)} ${width}w`);
  if (variants.length === 0) return undefined;
  return [...variants, `${attachment.url} ${attachment.width}w`].join(", ");
}

/**
 * The shared, responsive renderer for feed, thread, profile, and moderation
 * posts.
 *
 * `compact` renders a row of small square thumbnails with no link wrappers —
 * for list rows like the moderation queue, where the whole row is a `<button>`
 * and an interactive `<a>` cannot nest inside it. A thumbnail click bubbles to
 * that button rather than opening the image, which is the point: the queue row
 * opens the case, and the case dialog renders the full, link-wrapped grid.
 *
 * `priority` (0.4.0) loads the attachment eagerly at display width for the
 * card a cold visitor's LCP lands on — the first feed card, a thread's
 * focused post. Every other attachment keeps `loading="lazy"`, which on a
 * cold authenticated load was deferring the LCP image ~700 ms behind
 * discovery.
 */
export function PostAttachmentGrid({
  attachments,
  compact = false,
  priority = false,
}: {
  attachments: readonly PostAttachmentView[];
  compact?: boolean;
  priority?: boolean;
}) {
  if (attachments.length === 0) return null;

  if (compact) {
    return (
      <div className="flex flex-wrap gap-1.5" aria-label={m.post_images_hint()}>
        {attachments.map((attachment, index) => (
          <img
            key={attachment.id}
            src={attachment.url}
            srcSet={attachmentSrcSet(attachment)}
            sizes="56px"
            alt={m.post_attachment_alt({ position: String(index + 1) })}
            width={attachment.width}
            height={attachment.height}
            loading="lazy"
            decoding="async"
            className="size-14 rounded-md object-cover"
          />
        ))}
      </div>
    );
  }

  const isSingle = attachments.length === 1;

  return (
    <div
      className={`mb-3 grid gap-2 overflow-hidden rounded-lg ${
        isSingle ? "grid-cols-1" : "grid-cols-2"
      }`}
      aria-label={m.post_images_hint()}
    >
      {attachments.map((attachment, index) => {
        const position = String(index + 1);

        return (
          <ImageViewer
            key={attachment.id}
            src={attachment.url}
            alt={m.post_attachment_alt({ position })}
            title={m.post_attachment_alt({ position })}
            description={m.post_attachment_view({ position })}
            triggerLabel={m.post_attachment_view({ position })}
            triggerClassName="bg-muted/30 block overflow-hidden rounded-lg focus-visible:ring-ring focus-visible:ring-2"
          >
            {/*
              A single image renders at its intrinsic aspect ratio. The shared
              `h-full … object-cover` treatment centre-cropped it whenever the
              surface was wider than ~683px — the width at which a square image
              crosses the 512px ceiling — so on the wide profile feed almost
              every post cropped, and heavily (issue #209).

              The 32rem cap survives only as a proportional ceiling. With
              `w-full` making width definite, `max-h-…` clamping height leaves
              the box ratio-violating; the default `object-fit: fill` would then
              *stretch* the content (squishing tall/square images vertically —
              a worse defect than the original crop). `object-contain` keeps the
              ratio and fits within the cap, letterboxing into the parent's
              muted background instead of distorting. Grid cells keep the
              uniform cover-cropped look so mixed-ratio rows stay aligned.

              `sizes` follows the same split: a single image spans the feed
              column, a grid cell half of it.
            */}
            <img
              src={attachment.url}
              srcSet={attachmentSrcSet(attachment)}
              sizes={
                isSingle ? "(max-width: 672px) 100vw, 640px" : "(max-width: 672px) 50vw, 320px"
              }
              alt={m.post_attachment_alt({ position })}
              width={attachment.width}
              height={attachment.height}
              loading={priority && index === 0 ? "eager" : "lazy"}
              // Only the very first image of a priority card races the LCP;
              // the rest of even that card is below the fold.
              fetchPriority={priority && index === 0 ? "high" : undefined}
              decoding={priority && index === 0 ? "sync" : "async"}
              className={`rounded-lg transition-opacity hover:opacity-90 ${
                isSingle
                  ? "block h-auto max-h-[32rem] w-full object-contain"
                  : "h-full max-h-[32rem] w-full object-cover"
              }`}
            />
          </ImageViewer>
        );
      })}
    </div>
  );
}
