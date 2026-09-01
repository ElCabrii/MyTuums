/**
 * The landing page's whole theme state. The app owns a Jotai atom for this
 * (apps/web/src/atoms/theme.ts); this site has no shared state to speak of,
 * so the smallest honest equivalent is three functions over the same
 * `localStorage` vocabulary — same key, same values — so the two sites never
 * grow different words for the same preference.
 */
const STORAGE_KEY = "mytuums-ui-theme";
const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export type ThemeChoice = "light" | "dark" | "system";

function matchesDarkScheme(): boolean {
  return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

/** Applies a choice to the document — the one place the `.dark` class is set. */
export function applyTheme(choice: ThemeChoice): void {
  const dark = choice === "system" ? matchesDarkScheme() : choice === "dark";
  document.documentElement.classList.toggle("dark", dark);
}

/** This device's stored choice, or `null` when it never made one. */
export function readStoredTheme(): ThemeChoice | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : null;
  } catch {
    return null;
  }
}

function storeTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Private-browsing modes throw on write; the toggle still works for the
    // session, it just does not survive a reload.
  }
}

/**
 * The toggle's whole contract: flip the current *resolved* theme and store
 * the explicit choice. Storing "system" is the app's job; a visitor who
 * clicks the sun/moon on a landing page has made an explicit choice.
 */
export function toggleTheme(): void {
  const dark = document.documentElement.classList.contains("dark");
  applyTheme(dark ? "light" : "dark");
  storeTheme(dark ? "light" : "dark");
}
