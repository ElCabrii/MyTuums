import type { ReactNode } from "react";

/**
 * The centered card shell shared by the auth pages (`/login`, `/register`,
 * `/forgot-password`, `/reset-password`, `/two-factor`, `/welcome`) and the
 * 404 / forbidden pages.
 *
 * The shell is the translucent acrylic card; each site appends its own layout
 * classes (`space-y-6`, `text-center space-y-4`, ...) via `className`, so
 * every site's class string is preserved exactly. The settings sections
 * deliberately do NOT use this: their variant drops `sm:p-8`/`shadow-2xl` and
 * renders a `<section>`, so they keep their own shell (`./settings/section.tsx`).
 */
export function PageCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={`border-border/50 bg-card/60 rounded-3xl border p-6 shadow-2xl backdrop-blur-xl sm:p-8 ${
        className ?? ""
      }`}
    >
      {children}
    </div>
  );
}
