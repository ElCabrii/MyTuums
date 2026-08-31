import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

/**
 * A post's creation timestamp and — when it has been edited — the "Edited"
 * marker beside it (issue #264).
 *
 * Extracted from `PostCard` because "the marker rides wherever the post
 * renders" is an invariant, not a per-surface choice: every surface that
 * renders a post's timestamp (cards, the moderation case view, whatever
 * comes next) gets both, in the same relative/exact split, for free. A
 * surface hand-rolling its own timestamp is how an edited post stops looking
 * edited somewhere.
 *
 * Both instants ride a machine-readable `<time>` element: the label is
 * locale prose, the `datetime` attribute is what assistive technology and
 * tooling read. `exact` picks the durable split — a card scrolling past
 * says "3 minutes ago", the focused post and other permalink-grade surfaces
 * say the date and time.
 *
 * The `title` on each element is the full formatted instant regardless of
 * `exact`: a relative label must still reveal the exact time on hover, the
 * pairing the case view's timestamps had before they moved here.
 */
export function PostTimestamps({
  createdAt,
  editedAt,
  exact = false,
}: {
  createdAt: Date;
  /** The LAST edit time, or null when the post was never edited. */
  editedAt: Date | null;
  exact?: boolean;
}) {
  const locale = getLocale();
  const label = (instant: Date) =>
    exact
      ? formatDateTime(instant, locale)
      : formatRelativeTime(instant, locale, m.post_just_now());

  return (
    <>
      <span className="text-muted-foreground text-xs">
        •{" "}
        <time dateTime={createdAt.toISOString()} title={formatDateTime(createdAt, locale)}>
          {label(createdAt)}
        </time>
      </span>
      {editedAt && (
        <span className="text-muted-foreground text-xs">
          •{" "}
          <time dateTime={editedAt.toISOString()} title={formatDateTime(editedAt, locale)}>
            {m.post_edited({ time: label(editedAt) })}
          </time>
        </span>
      )}
    </>
  );
}
