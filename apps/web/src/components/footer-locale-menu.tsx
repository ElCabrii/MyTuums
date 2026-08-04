import { Check, Languages } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { getLocale, locales, setLocale } from "@/paraglide/runtime.js";
import { m } from "@/paraglide/messages.js";

/**
 * The footer's locale switcher. Split out of `footer.tsx` so the footer can
 * stay static and load this on demand — the popover machinery (floating-ui +
 * focus management) is the heaviest thing in the footer, and the wordmark and
 * legal links beside it have no reason to wait for it.
 *
 * Read-only: `getLocale()` is a plain function call, not a subscription, so
 * this component has no hooks and no state of its own.
 */
export function FooterLocaleMenu() {
  const currentLocale = getLocale();
  const labelForLocale = (locale: (typeof locales)[number]) =>
    locale === "fr" ? m.locale_french() : m.locale_english();

  return (
    <DropdownMenu>
      {/* WCAG 2.5.3 (label in name): the trigger's accessible name must
          contain its visible text, which here is the current locale
          ("English"/"Français") — a bare aria-label replaces it.
          "Language: English" reads correctly, and the E2E suite matches
          the button by "Language"/"Langue" as a substring. */}
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label={`${m.locale_label()}: ${labelForLocale(currentLocale)}`}
            title={m.locale_label()}
            className="gap-1.5"
          />
        }
      >
        <Languages className="size-4" />
        <span>{labelForLocale(currentLocale)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        {locales.map((locale) => (
          <DropdownMenuItem
            key={locale}
            onClick={() => void setLocale(locale)}
            className="justify-between"
          >
            <span>{labelForLocale(locale)}</span>
            {locale === currentLocale && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
