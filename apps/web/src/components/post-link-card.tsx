import { useAtomValue } from "jotai";
import { linkCardAtom } from "@/atoms/link-card";
import type { LinkCard } from "@/lib/orpc";

/**
 * The link preview card for a post's first URL (issue #260): domain, title,
 * description and — when the target provided one and the server stored it — a
 * lead image served from our own `/media/`, never hot-linked.
 *
 * Renders nothing until the card resolves, and nothing at all when it never
 * does: a dead URL, a timeout, a missing Open Graph payload or a refused
 * target all answer `{ card: null }`, and the post keeps the plain link it
 * always had. Only the first URL is ever passed here (`firstLinkUrl`); the
 * second and later URLs stay plain links.
 */
export function PostLinkCard({ url }: { url: string }) {
  const query = useAtomValue(linkCardAtom(url));
  const card: LinkCard | null = query.data?.card ?? null;
  if (!card) return null;

  // The same anchor treatment the inline link gets (`LinkedText`), plus the
  // whole-card surface: `noopener`/`noreferrer` keep the destination away from
  // this tab, and `nofollow ugc` states what the link is. The image is
  // decorative — its description is the title beside it.
  return (
    <a
      href={card.url}
      target="_blank"
      rel="noopener noreferrer nofollow ugc"
      className="border-border hover:border-primary/30 mb-3 flex overflow-hidden rounded-lg border transition-colors"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="min-w-0 flex-1 p-3">
        <p className="text-muted-foreground truncate text-xs">{card.domain}</p>
        <p className="text-foreground mt-0.5 line-clamp-2 text-sm font-bold">{card.title}</p>
        {card.description && (
          <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">{card.description}</p>
        )}
      </div>
      {card.imageUrl && (
        <img
          src={card.imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-24 w-24 shrink-0 object-cover sm:h-28 sm:w-28"
        />
      )}
    </a>
  );
}
