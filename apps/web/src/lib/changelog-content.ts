import { getLocale } from "@/paraglide/runtime.js";

/** The current locale's release notes, already rendered during the Vite build. */
export function currentChangelogHtml(): string | null {
  return __APP_CHANGELOG__[getLocale()] ?? null;
}
