import { atomEffect } from "jotai-effect";
import { getLocale } from "@/paraglide/runtime.js";
import { m } from "@/paraglide/messages.js";

/** Keeps document metadata aligned with the locale selected in the footer. */
export const localeDocumentEffect = atomEffect(() => {
  const root = document.documentElement;
  root.lang = getLocale();
  document.title = m.app_document_title();
  document.querySelector('meta[name="description"]')?.setAttribute("content", m.app_document_description());
});
