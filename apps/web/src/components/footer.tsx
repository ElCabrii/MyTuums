import { Link } from "@tanstack/react-router";
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

export function Footer() {
  const currentLocale = getLocale();
  const labelForLocale = (locale: (typeof locales)[number]) =>
    locale === "fr" ? m.locale_french() : m.locale_english();

  return (
    <footer className="w-full border-t bg-background py-6 md:py-8 mt-auto">
      <div className="w-full flex flex-col md:flex-row items-center justify-between gap-4 px-4 sm:px-8 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <img src="/mytuums.svg" alt={m.app_logo_alt()} className="h-5 w-auto" />
          <span className="font-semibold text-foreground">MyTuums</span>
          <span>{m.footer_copyright({ year: String(new Date().getFullYear()) })}</span>
        </div>
        <div className="flex flex-wrap items-center gap-4 sm:gap-6">
          <Link to="/" className="hover:underline hover:text-foreground">
            {m.nav_home()}
          </Link>
          <Link to="/discover" className="hover:underline hover:text-foreground">
            {m.nav_discover()}
          </Link>
          <Link to="/privacy" className="hover:underline hover:text-foreground">
            {m.legal_privacy_policy()}
          </Link>
          <Link to="/terms" className="hover:underline hover:text-foreground">
            {m.legal_terms_of_service()}
          </Link>
          <Link to="/mentions-legales" className="hover:underline hover:text-foreground">
            {m.legal_notice()}
          </Link>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={m.locale_label()}
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
        </div>
      </div>
    </footer>
  );
}
