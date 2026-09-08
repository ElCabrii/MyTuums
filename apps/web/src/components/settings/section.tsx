/** Shared card layout; titles sit below the active settings category. */
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
    <section className="bg-card space-y-5 rounded-2xl border p-4 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="text-primary mt-0.5">{icon}</div>
        <div className="space-y-1">
          <h3 className="font-semibold">{title}</h3>
          <p className="text-muted-foreground text-sm leading-relaxed">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}
