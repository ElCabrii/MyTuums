import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { atomEffect } from "jotai-effect";
import { viewerAtom } from "@/atoms/session";

/** The theme choices the app offers: an explicit pair, or "system" to follow the OS. */
export type Theme = "dark" | "light" | "system";

const STORAGE_KEY = "mytuums-ui-theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

const isTheme = (value: unknown): value is Theme =>
  value === "dark" || value === "light" || value === "system";

/**
 * `matchMedia` doesn't exist outside a browser, and importing this module —
 * from tooling, or anywhere that only cares about `themeAtom` — must not
 * throw just because nothing touched the DOM yet. Every read goes through
 * this rather than the bare global so the module stays importable anywhere.
 */
const matchDarkScheme = (): MediaQueryList | undefined =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(MEDIA_QUERY)
    : undefined;

/**
 * The raw persisted value — this device's own choice, or `null` if it has
 * never made one.
 *
 * Typed `unknown` on purpose, same as `feedScopeAtom` in `feed-scope.ts`:
 * `localStorage` is user-editable and outlives deploys, so nothing read back
 * out of it is trustworthy — `themeAtom` below is the only sanctioned way in.
 * The key is kept identical to the old `ThemeProvider`'s `storageKey` prop so
 * existing users don't lose their preference across this migration.
 *
 * The default is `null` rather than `"system"`, and that distinction is the
 * whole mechanism behind the stored account preference: `"system"` is a real
 * choice someone can make, so defaulting to it made "I picked system here"
 * indistinguishable from "I have never touched this on this device" — and the
 * account's preference could then never apply anywhere, because every device
 * would look like it had already chosen.
 *
 * `getOnInit` matters for the same reason it does in `feed-scope.ts`:
 * without it the atom yields the default on the very first read and the
 * stored value only afterwards, which would paint the wrong theme for one
 * frame — a visible flash that then flips — instead of the right one
 * immediately. The app is a client-rendered SPA, so there is no hydration
 * pass for that first read to mismatch against.
 */
const storedThemeAtom = atomWithStorage<unknown>(STORAGE_KEY, null, undefined, {
  getOnInit: true,
});

/**
 * The theme in force: this device's choice, else the account's stored default,
 * else follow the OS.
 *
 * That order is the rule the whole feature rests on — the header's toggle is an
 * override for the device you are sitting at, and `/settings/account` sets the
 * default a device that has never been told anything falls back to. So a new
 * browser honours the preference, and flipping the toggle there beats it
 * immediately and permanently, without writing back to the account.
 *
 * Reads collapse anything unrecognised — a hand-edited key, a value from a
 * future version of the app, a `themePreference` off the wire — to the next
 * source rather than letting it reach `themeClassEffect`, where an
 * unrecognised string would still pass through to `classList.add` and apply
 * neither `light` nor `dark`. Writes are typed, so only the three real values
 * are ever stored.
 */
export const themeAtom = atom(
  (get): Theme => {
    const stored = get(storedThemeAtom);
    if (isTheme(stored)) return stored;

    const preferred = get(viewerAtom)?.themePreference;
    if (isTheme(preferred)) return preferred;

    return "system";
  },
  (_get, set, next: Theme) => {
    set(storedThemeAtom, next);
  },
);

/**
 * The OS-level preference, tracked independently of what the viewer picked.
 * Kept as its own atom so an explicit `"light"`/`"dark"` choice can ignore
 * it entirely, while `"system"` can follow it live.
 */
const systemThemeAtom = atom<"dark" | "light">(matchDarkScheme()?.matches ? "dark" : "light");

/**
 * `onMount` is what gives a plain atom a subscription lifecycle: it runs
 * once something actually starts watching the atom, and its return value is
 * called on unwatch. Returning the `removeEventListener` here is what fixes
 * the old provider's defect — it only ever read `matchMedia(...).matches`
 * once inside a `useEffect`, so switching the OS theme with the app open did
 * nothing until a reload re-ran that effect. Without returning the cleanup,
 * every mount would leak another listener instead of replacing the last one.
 */
systemThemeAtom.onMount = (set) => {
  const mql = matchDarkScheme();
  if (!mql) return;

  const listener = (event: MediaQueryListEvent) => {
    set(event.matches ? "dark" : "light");
  };

  mql.addEventListener("change", listener);
  return () => mql.removeEventListener("change", listener);
};

/** What actually gets painted: the explicit choice, or the live OS value when `"system"`. */
export const resolvedThemeAtom = atom((get) =>
  get(themeAtom) === "system" ? get(systemThemeAtom) : get(themeAtom),
);

/**
 * The one side effect in this module. `atomEffect` (from `jotai-effect`)
 * re-runs its callback whenever a read dependency changes, for as long as
 * something keeps it mounted — the same lifecycle as `onMount` above, but
 * for derived state rather than an external source. It is mounted once, at
 * the root layout, so the class is applied exactly once per theme change no
 * matter how many components care about the theme.
 */
export const themeClassEffect = atomEffect((get) => {
  const resolved = get(resolvedThemeAtom);
  const root = document.documentElement;

  root.classList.remove("light", "dark");
  root.classList.add(resolved);
});
