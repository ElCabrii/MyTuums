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

/** The shared, responsive renderer for feed, thread, profile, and moderation posts. */
export function PostAttachmentGrid({
  attachments,
}: {
  attachments: readonly PostAttachmentView[];
}) {
  if (attachments.length === 0) return null;

  const isSingle = attachments.length === 1;

  return (
    <div
      className={`mb-3 grid gap-2 overflow-hidden rounded-lg ${
        isSingle ? "grid-cols-1" : "grid-cols-2"
      }`}
      aria-label={m.post_images_hint()}
    >
      {attachments.map((attachment, index) => (
        <a
          key={attachment.id}
          href={attachment.url}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="bg-muted/30 focus-visible:ring-ring block overflow-hidden rounded-lg outline-none focus-visible:ring-2"
        >
          {/*
            A single image renders at its intrinsic aspect ratio. The shared
            `h-full … object-cover` treatment centre-cropped it whenever the
            surface was wider than ~683px — the width at which a square image
            crosses the 512px ceiling — so on the wide profile feed almost
            every post cropped, and heavily (issue #209). Here the 32rem cap
            survives only as a proportional ceiling: taller images scale down
            and centre (`w-full h-auto max-h-…` triggers the replaced-element
            constraint rules, which preserve the ratio) instead of cropping.
            Grid cells keep the uniform cover-cropped look so mixed-ratio
            rows stay aligned.
          */}
          <img
            src={attachment.url}
            alt={m.post_attachment_alt({ position: String(index + 1) })}
            width={attachment.width}
            height={attachment.height}
            loading="lazy"
            decoding="async"
            className={`rounded-lg transition-opacity hover:opacity-90 ${
              isSingle
                ? "mx-auto block h-auto max-h-[32rem] w-full"
                : "h-full max-h-[32rem] w-full object-cover"
            }`}
          />
        </a>
      ))}
    </div>
  );
}
