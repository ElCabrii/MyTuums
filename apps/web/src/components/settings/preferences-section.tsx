import { useAtomValue, useSetAtom } from "jotai";
import { Settings2 } from "lucide-react";
import { authPendingAtom } from "@/atoms/auth";
import { saveLocalePreferenceAtom, saveThemePreferenceAtom } from "@/atoms/account";
import { viewerAtom } from "@/atoms/session";
import type { Theme } from "@/atoms/theme";
import { SegmentedControl, SegmentedControlItem } from "@/components/segmented-control";
import { Section } from "@/components/settings/section";
import { locales, type Locale } from "@/paraglide/runtime.js";
import { m } from "@/paraglide/messages.js";

const THEMES: { value: Theme; label: () => string }[] = [
  { value: "light", label: () => m.theme_light() },
  { value: "dark", label: () => m.theme_dark() },
  { value: "system", label: () => m.theme_system() },
];

const localeLabel = (locale: Locale): string =>
  locale === "fr" ? m.locale_french() : m.locale_english();

/**
 * The account's *default* theme and language.
 *
 * Deliberately not a second copy of the header's theme toggle and the footer's
 * language switcher — those change this device, right now, and keep doing so.
 * These change what a device that has never been told anything falls back to,
 * which is what makes a preference follow someone to a new browser. The
 * resolution order lives in `atoms/theme.ts` and `atoms/locale.ts`; the copy
 * below is the only place a person is told about it.
 *
 * Saving also applies the choice here, which is why the two controls read from
 * the session rather than from `themeAtom`/`getLocale()`: they show what is
 * *stored on the account*, not what this device happens to be doing. Without
 * that distinction the control would appear to already agree with a setting
 * that had never been saved.
 *
 * A segmented control rather than a `<select>` because there is no
 * `ui/select.tsx` and these are three- and two-way choices — the same shape
 * `home-page.tsx` uses for the feed switch, with the same `role="group"` and
 * `aria-pressed` semantics.
 */
export function PreferencesSection() {
  const viewer = useAtomValue(viewerAtom);
  const isBusy = useAtomValue(authPendingAtom);
  const saveTheme = useSetAtom(saveThemePreferenceAtom);
  const saveLocale = useSetAtom(saveLocalePreferenceAtom);

  const storedTheme = viewer?.themePreference ?? null;
  const storedLocale = viewer?.localePreference ?? null;

  return (
    <Section
      title={m.settings_prefs_title()}
      description={m.settings_prefs_description()}
      icon={<Settings2 className="h-5 w-5" />}
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {m.settings_prefs_theme_label()}
          </p>
          <SegmentedControl label={m.settings_prefs_theme_label()}>
            {THEMES.map(({ value, label }) => (
              <SegmentedControlItem
                key={value}
                active={storedTheme === value}
                onClick={() => {
                  if (!isBusy) void saveTheme(value);
                }}
              >
                {label()}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {m.settings_prefs_locale_label()}
          </p>
          <SegmentedControl label={m.settings_prefs_locale_label()}>
            {locales.map((locale) => (
              <SegmentedControlItem
                key={locale}
                active={storedLocale === locale}
                onClick={() => {
                  if (!isBusy) void saveLocale(locale);
                }}
              >
                {localeLabel(locale)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>

        <p className="text-xs text-muted-foreground">{m.settings_prefs_hint()}</p>
      </div>
    </Section>
  );
}
