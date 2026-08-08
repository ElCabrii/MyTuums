import type { ReactNode } from "react";
import type { UserX } from "lucide-react";

/**
 * The centred card used when a page's subject can't be shown — an unclaimed
 * handle, a missing post, or a request that failed. Hoisted out of
 * routes/@{$username}.tsx so every such state is byte-identical rather than a
 * near-miss; `profile-layout.tsx` and `thread-page.tsx` both render it.
 */
export function ProfileMessage({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof UserX;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="container mx-auto max-w-md px-4 py-16">
      <div className="bg-card rounded-xl border p-6 text-center shadow-sm">
        <div className="mb-4 flex justify-center">
          <div className="bg-primary/10 text-primary rounded-full p-3">
            <Icon className="h-8 w-8" />
          </div>
        </div>
        <h1 className="mb-1 text-2xl font-bold tracking-tight">{title}</h1>
        {children}
      </div>
    </div>
  );
}
