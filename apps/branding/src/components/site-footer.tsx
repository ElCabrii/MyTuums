import { LocaleMenu } from "@/components/locale-menu";
import { m } from "@/paraglide/messages.js";
import { signInUrl, signUpUrl } from "@/lib/site";

/** The footer: wordmark and tagline, the app links, the locale menu. */
export function SiteFooter() {
  return (
    <footer className="border-border/60 border-t">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-4 px-4 py-10 sm:flex-row sm:px-6">
        <div className="flex items-center gap-2.5">
          <img src="/mytuums.svg" alt="" className="h-6 w-auto" />
          <span className="text-muted-foreground text-sm">{m.footer_tagline()}</span>
        </div>
        <nav aria-label={m.nav_open_app()} className="flex items-center gap-4 text-sm sm:ml-auto">
          <a
            href={signUpUrl}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            {m.hero_cta_primary()}
          </a>
          <a
            href={signInUrl}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            {m.hero_cta_secondary()}
          </a>
          <LocaleMenu />
        </nav>
      </div>
    </footer>
  );
}
