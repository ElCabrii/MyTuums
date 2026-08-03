import { atomEffect } from "jotai-effect";
import { getLocale, locales, setLocale } from "@/paraglide/runtime.js";
import { m } from "@/paraglide/messages.js";
import { sessionPendingAtom, viewerAtom } from "@/atoms/session";

/** Keeps document metadata aligned with the locale selected in the footer. */
export const localeDocumentEffect = atomEffect(() => {
  const root = document.documentElement;
  root.lang = getLocale();
  document.title = m.app_document_title();
  document.querySelector('meta[name="description"]')?.setAttribute("content", m.app_document_description());
});

/** The cookie Paraglide resolves the locale from, and the BetterAuth i18n plugin reads. */
const LOCALE_COOKIE = "PARAGLIDE_LOCALE";

/**
 * Whether this device has ever chosen a language.
 *
 * The cookie's *presence* is the signal, not its value — exactly the role
 * `localStorage` plays for the theme in `./theme.ts`. Paraglide's strategy is
 * `["cookie", "globalVariable", "baseLocale"]`, so with no cookie the app is
 * silently on `baseLocale` (English) because nothing has said otherwise, which
 * is precisely the "no choice made here" state the account preference should
 * fill.
 */
function hasLocaleCookie(): boolean {
  return document.cookie.split("; ").some((entry) => entry.startsWith(`${LOCALE_COOKIE}=`));
}

const isLocale = (value: unknown): value is (typeof locales)[number] =>
  typeof value === "string" && (locales as readonly string[]).includes(value);

/**
 * Applies the account's stored language on a device that has never picked one.
 *
 * The mirror of the theme rule in `./theme.ts`, but it cannot be a derived atom
 * the way `themeAtom` is: Paraglide resolves the locale at *module* scope and
 * `m.some_key()` reads it synchronously everywhere, so switching languages is a
 * document reload (`setLocale`'s default) rather than a re-render. This is
 * therefore an effect that reloads once, not a value components read.
 *
 * Three guards, each load-bearing:
 *
 * - `sessionPendingAtom` first, for the same reason `settings.account.tsx`
 *   checks it before its sign-in guard: on a cold load `viewerAtom` is null
 *   while BetterAuth's first `/get-session` is still in flight, and acting then
 *   would read "no preference" from a session that simply hasn't arrived.
 * - `hasLocaleCookie()` is what stops this fighting the footer switcher.
 *   Switching language *sets* that cookie, so once someone has chosen on this
 *   device this effect can never override them — and, just as importantly, it
 *   is what bounds the reload to at most once per device.
 * - The equality check makes the reload conditional rather than unconditional.
 *   Without it, an account whose preference already matches `baseLocale` would
 *   reload on every single cold load, forever.
 */
export const localePreferenceEffect = atomEffect((get) => {
  if (get(sessionPendingAtom)) return;

  const preferred = get(viewerAtom)?.localePreference;
  if (!isLocale(preferred)) return;
  if (preferred === getLocale()) return;
  if (hasLocaleCookie()) return;

  // Reloads the document, which is the point: every `m.*()` call in the tree
  // resolved its string at import time and none of them re-render on a locale
  // change.
  void setLocale(preferred);
});
