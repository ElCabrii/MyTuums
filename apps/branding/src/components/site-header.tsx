import { Button } from "@/components/ui/button";
import { LocaleMenu } from "@/components/locale-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { m } from "@/paraglide/messages.js";
import { signInUrl } from "@/lib/site";

/** The sticky top bar: wordmark, one anchor, and the site's three controls. */
export function SiteHeader() {
  return (
    <header className="border-border/60 bg-background/80 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <a href="/" className="flex items-center gap-2.5" aria-label="MyTuums">
          <img src="/mytuums.svg" alt="" className="h-7 w-auto" />
          <span className="text-lg font-semibold tracking-tight">MyTuums</span>
        </a>
        <nav aria-label={m.nav_features()} className="ml-6 hidden sm:block">
          <a
            href="#features"
            className="text-muted-foreground hover:text-foreground text-sm transition-colors"
          >
            {m.nav_features()}
          </a>
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <ThemeToggle />
          <LocaleMenu />
          <Button variant="outline" size="sm" render={<a href={signInUrl} />}>
            {m.nav_open_app()}
          </Button>
        </div>
      </div>
    </header>
  );
}
