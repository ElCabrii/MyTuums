import type { UserX } from "lucide-react";

/**
 * The centred card used for a profile that can't be shown — an unclaimed
 * handle, or a request that failed. Hoisted out of routes/@{$username}.tsx so
 * the follower and following routes render byte-identical states rather than
 * near-misses.
 */
export function ProfileMessage({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof UserX;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="container max-w-md mx-auto py-16 px-4">
      <div className="rounded-xl border bg-card p-6 shadow-sm text-center">
        <div className="flex justify-center mb-4">
          <div className="p-3 rounded-full bg-primary/10 text-primary">
            <Icon className="h-8 w-8" />
          </div>
        </div>
        <h1 className="text-2xl font-bold tracking-tight mb-1">{title}</h1>
        {children}
      </div>
    </div>
  );
}
