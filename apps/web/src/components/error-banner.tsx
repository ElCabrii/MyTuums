import { AlertCircle } from "lucide-react";

/**
 * The one `role="alert"` error surface per page, shared by the auth pages and
 * `/settings/account`. The message is localised at the call site
 * (`localizeAuthError` stays there); an optional `title` renders the auth
 * pages' "… failed" heading above it — `/settings/account` has no title and
 * passes just the message.
 */
export function ErrorBanner({
  message,
  title,
  className,
}: {
  message: string;
  title?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={`bg-destructive/10 border-destructive/20 text-destructive flex items-start gap-3 rounded-2xl border p-4 text-sm ${
        className ?? ""
      }`}
    >
      <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
      {title ? (
        <div>
          <p className="font-medium">{title}</p>
          <p className="text-destructive/90 mt-0.5 text-xs">{message}</p>
        </div>
      ) : (
        <p>{message}</p>
      )}
    </div>
  );
}
