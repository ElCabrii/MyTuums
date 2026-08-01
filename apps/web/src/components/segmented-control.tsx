import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A row of buttons styled as a segmented control — the For you|Following feed
 * switch on the home page.
 *
 * This was a `<nav>` of `<Link>`s while the feed lived in `?feed=`. Nothing
 * here navigates any more: the selection is client state (see
 * `@/lib/feed-scope`), so the group is a `role="group"` of toggle buttons and
 * the selected one reports `aria-pressed` rather than `aria-current="page"` —
 * there is no current *page* for it to be current about.
 *
 * Base UI's `Tabs` would fit now that the router is out of the picture, but it
 * owns its own selected state and expects `Tabs.Panel` children, so adopting it
 * would mean restructuring the page around it to swap one feed component.
 */
export function SegmentedControl({
  label,
  className,
  children,
}: {
  /** Names the group for screen readers, e.g. "Feed". */
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-slot="segmented-control"
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-muted/50 p-0.5",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SegmentedControlItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="sm"
      data-slot="segmented-control-item"
      className="rounded-full"
      // `aria-pressed` is what actually communicates the selection; the variant
      // swap above is only the visual half of it.
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
