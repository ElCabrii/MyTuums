import type { ReactNode } from "react";
import { AlertCircle, Loader2, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages.js";

/**
 * The query-result fields the four-state skeleton reads. Every `atomWith*Query`
 * result is structurally assignable to this — infinite queries additionally
 * carry `hasNextPage`/`fetchNextPage`, plain queries don't, so both shapes are
 * covered.
 */
export interface PaginatedStateQuery {
  isPending: boolean;
  isError: boolean;
  error: { message?: string } | null;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  refetch: () => void;
  fetchNextPage?: () => void;
}

/**
 * The paginated four-state skeleton shared by the feed, people list,
 * moderation views and search sections: loading spinner, `role="alert"` retry,
 * dashed empty state, and the "Load more" button.
 *
 * `isEmpty` and `children` stay at the call site because each site knows its
 * own data shape (infinite `.pages` vs plain `.items`) and its own row
 * renderer. Every class string is preserved from the sites this was extracted
 * from; only the text varies, through props.
 */
export function PaginatedState({
  query,
  errorMessage,
  emptyIcon: EmptyIcon,
  emptyMessage,
  isEmpty,
  emptyAction,
  listClassName,
  loadingFallback,
  children,
}: {
  query: PaginatedStateQuery;
  /** Fallback for the retry alert when `query.error.message` is empty. */
  errorMessage: string;
  /** The icon centred above the empty message. */
  emptyIcon: LucideIcon;
  emptyMessage: string;
  /** Whether the loaded data has no items — computed by the caller, which knows its own shape. */
  isEmpty: boolean;
  /** Rendered under `emptyMessage` — e.g. a "find people to follow" CTA. */
  emptyAction?: ReactNode;
  /** The class for the loaded-content wrapper (`space-y-*`). */
  listClassName?: string;
  /**
   * Replaces the centred spinner while the first page loads. Sites whose rows
   * have a fixed shape (the moderation desk) pass a skeleton of that shape so
   * the list does not jump when the data lands; everywhere else the spinner
   * stays, because a skeleton of a variable-height post would be a lie.
   */
  loadingFallback?: ReactNode;
  /** The loaded rows, rendered between the wrapper and the "Load more" button. */
  children: ReactNode;
}) {
  if (query.isPending) {
    return (
      loadingFallback ?? (
        <div className="flex justify-center py-12">
          <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
        </div>
      )
    );
  }

  if (query.isError) {
    return (
      <div
        role="alert"
        className="border-destructive/20 bg-destructive/10 text-destructive flex items-start gap-3 rounded-xl border p-4 text-sm"
      >
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="space-y-2">
          <p>{query.error?.message || errorMessage}</p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            {m.common_try_again()}
          </Button>
        </div>
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="border-border bg-card/40 rounded-xl border border-dashed p-10 text-center">
        <EmptyIcon className="text-muted-foreground/60 mx-auto mb-3 h-8 w-8" />
        <p className="text-muted-foreground text-sm">{emptyMessage}</p>
        {emptyAction && <div className="mt-4 flex justify-center">{emptyAction}</div>}
      </div>
    );
  }

  return (
    <div className={listClassName}>
      {children}

      {query.hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.fetchNextPage?.()}
            disabled={query.isFetchingNextPage}
            className="gap-2 rounded-full"
          >
            {query.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>{m.common_load_more()}</span>
          </Button>
        </div>
      )}
    </div>
  );
}
