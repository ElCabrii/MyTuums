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

  return (
    <div
      className={`mb-3 grid gap-2 overflow-hidden rounded-lg ${
        attachments.length === 1 ? "grid-cols-1" : "grid-cols-2"
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
          <img
            src={attachment.url}
            alt={m.post_attachment_alt({ position: String(index + 1) })}
            width={attachment.width}
            height={attachment.height}
            loading="lazy"
            decoding="async"
            className="h-full max-h-[32rem] w-full object-cover transition-opacity hover:opacity-90"
          />
        </a>
      ))}
    </div>
  );
}
