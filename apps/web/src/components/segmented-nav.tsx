import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A row of links styled as a segmented control — the Following|Global feed
 * switch on the home page, and Posts|Followers|Following on a profile.
 *
 * Built on `<Link>` rather than a Base UI `Tabs` primitive because every use
 * of this *navigates*: one moves a search param, the other moves between
 * routes. `Tabs` owns its own selected state and expects `Tabs.Panel`
 * children, so it would have to be driven from the router and would fight it
 * on back/forward. Routing through `Link` also keeps the `href` — and so
 * middle-click and "open in new tab" — which a plain button throws away.
 *
 * Note the rendered element reports `role="button"`, not `role="link"`:
 * `Button` with `nativeButton={false}` applies Base UI's button semantics to
 * whatever it renders. That matches how the header nav and the home page's
 * Log in / Register controls already behave, so this stays consistent with
 * the rest of the app rather than inventing a second convention.
 */
export function SegmentedNav({
  label,
  className,
  children,
}: {
  /** Names the group for screen readers, e.g. "Feed" or "Profile sections". */
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <nav
      aria-label={label}
      data-slot="segmented-nav"
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-muted/50 p-0.5",
        className,
      )}
    >
      {children}
    </nav>
  );
}

/**
 * Takes the `<Link>` as a `render` element rather than accepting its props,
 * for the same reason `Button` does: `Link` is generic over the route tree, so
 * forwarding `React.ComponentProps<typeof Link>` through a wrapper erases the
 * inference and `to`/`params`/`search` stop being type-checked against the
 * generated routes.
 */
export function SegmentedNavItem({
  active,
  render,
  children,
}: {
  active: boolean;
  render: React.ReactElement;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="sm"
      nativeButton={false}
      data-slot="segmented-nav-item"
      className="rounded-full"
      // `aria-current` is what actually communicates the selection; the
      // variant swap above is only the visual half of it.
      aria-current={active ? "page" : undefined}
      render={render}
    >
      {children}
    </Button>
  );
}
