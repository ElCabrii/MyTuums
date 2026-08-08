import type { ReactNode } from "react";

/**
 * Shared prose styling for the legal pages, applied via arbitrary-variant
 * selectors so the content components below can stay plain semantic HTML
 * instead of repeating className props on every element — the app has no
 * typography plugin, and three static pages don't justify adding one.
 */
export function LegalDocument({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <article className="[&_p]:text-muted-foreground [&_em]:text-muted-foreground [&_ul]:text-muted-foreground [&_a]:text-link hover:[&_a]:text-link/80 [&_strong]:text-foreground [&_th]:text-foreground [&_td]:border-border [&_td]:text-muted-foreground mx-auto max-w-3xl px-4 py-12 sm:px-8 [&_a]:underline [&_a]:underline-offset-2 [&_em]:mb-6 [&_em]:block [&_em]:text-sm [&_em]:not-italic [&_h1]:mb-1 [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:tracking-tight [&_h2]:mt-9 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:first-of-type:mt-6 [&_p]:mb-4 [&_p]:leading-relaxed [&_strong]:font-semibold [&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm [&_td]:border-b [&_td]:py-2 [&_td]:pr-4 [&_td]:align-top [&_th]:border-b [&_th]:pr-4 [&_th]:pb-2 [&_th]:text-left [&_th]:font-semibold [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-6">
      <h1>{title}</h1>
      <p className="text-muted-foreground mb-8 text-sm">{updated}</p>
      {children}
    </article>
  );
}
