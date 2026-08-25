/**
 * The card every settings block renders inside.
 *
 * Extracted alongside the sections themselves when `/settings/account` grew
 * past four blocks — the route is now composition, and each section is a file
 * that can be read on its own. The shell stays here rather than in
 * `components/ui/` because it is this page's layout, not a design-system
 * primitive: nothing else in the app renders a titled card with a leading icon.
 *
 * The title is an `<h3>`: `/settings/account` groups the cards under two
 * `<h2>` landmarks (Profile, Account — see `routes/settings.account.tsx`), so
 * each card's title nests one level below its group rather than competing with
 * it for the same heading level.
 */
import type { ReactNode } from "react";

export function Section({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-border/50 bg-card/60 space-y-4 rounded-3xl border p-6 backdrop-blur-xl">
      <div className="flex items-start gap-3">
        <div className="text-primary mt-0.5">{icon}</div>
        <div className="space-y-1">
          <h3 className="font-semibold">{title}</h3>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}
