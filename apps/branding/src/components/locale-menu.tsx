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
 * The site's locale switcher, mirroring the app's footer menu
 * (apps/web/src/components/footer-locale-menu.tsx) so both sites switch
 * language the same way: `setLocale` writes Paraglide's cookie and reloads
 * the document, which is exactly what a statically-translated page wants.
 *
 * Read-only: `getLocale()` is a plain function call, not a subscription, so
 * this component has no hooks and no state of its own.
 */
export function LocaleMenu() {
  const currentLocale = getLocale();
  const labelForLocale = (locale: (typeof locales)[number]) =>
    locale === "fr" ? m.locale_french() : m.locale_english();

  return (
    <DropdownMenu>
      {/* WCAG 2.5.3 (label in name): the trigger's accessible name must
          contain its visible text — the current language's name — so the
          aria-label prefixes it rather than replacing it. */}
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={`${m.locale_label()}: ${labelForLocale(currentLocale)}`}
            title={m.locale_label()}
          />
        }
      >
        <Languages className="size-5" />
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
