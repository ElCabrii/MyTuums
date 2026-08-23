import { useEffect } from "react";
import { documentTitle, setDocumentHead } from "@/lib/document-head";
import { m } from "@/paraglide/messages.js";

/**
 * Updates the route-owned static head with values that arrive through a page's
 * query atom. The route's `head()` remains the loading/not-found fallback;
 * this hook only fills the profile/post content once it is available.
 */
export function useDocumentHead(pageName: string, description?: string): void {
  const resolvedDescription = description?.trim() || m.app_document_description();
  const title = documentTitle(pageName);

  useEffect(() => {
    setDocumentHead(pageName, resolvedDescription);
  }, [pageName, resolvedDescription, title]);
}
