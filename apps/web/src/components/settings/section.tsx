/**
 * The card every settings block renders inside.
 *
 * Extracted alongside the sections themselves when `/settings/account` grew
 * past four blocks — the route is now composition, and each section is a file
 * that can be read on its own. The shell stays here rather than in
 * `components/ui/` because it is this page's layout, not a design-system
 * primitive: nothing else in the app renders a titled card with a leading icon.
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
    <section className="rounded-3xl border border-border/50 bg-card/60 backdrop-blur-xl p-6 space-y-4">
      <div className="flex items-start gap-3">
        <div className="text-primary mt-0.5">{icon}</div>
        <div className="space-y-1">
          <h2 className="font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}
