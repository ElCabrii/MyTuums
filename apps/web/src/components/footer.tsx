import { lazy, Suspense } from "react";
import { Link } from "@tanstack/react-router";
import { m } from "@/paraglide/messages.js";
import { APP_VERSION } from "@/lib/app-version";
import { AnalyticsPreferencesButton } from "@/components/analytics-consent";

// The locale switcher is the only footer control that pulls in popover
// machinery (floating-ui + focus management); lazy-loading it keeps the
// wordmark and simple links/buttons static. The fallback reserves the locale
// control's button footprint so the legal row does not move when it mounts.
const FooterLocaleMenu = lazy(() =>
  import("@/components/footer-locale-menu").then((mod) => ({ default: mod.FooterLocaleMenu })),
);

/**
 * The site-wide footer: wordmark, copyright, legal links, and the lazy-loaded
 * locale switcher. Rendered by `__root.tsx` on every route, signed in or not.
 */
export function Footer() {
  return (
    <footer className="bg-background mt-auto w-full border-t py-6 md:py-8">
      <div className="text-muted-foreground flex w-full flex-col items-start justify-between gap-4 px-4 text-sm sm:px-8 md:flex-row md:items-center">
        <div className="flex w-full max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 md:w-auto">
          <img
            src="/mytuums.svg"
            alt={m.app_logo_alt()}
            width={2048}
            height={2048}
            className="h-5 w-auto"
          />
          <span className="text-foreground font-semibold">MyTuums</span>
          <span className="text-xs">{`v${APP_VERSION}`}</span>
          <span className="min-w-0 break-words">
            {m.footer_copyright({ year: String(new Date().getFullYear()) })}
          </span>
        </div>
        <div className="flex w-full flex-wrap items-center justify-start gap-x-4 gap-y-2 sm:gap-x-6 md:w-auto md:justify-end">
          <Link to="/" className="hover:text-foreground hover:underline">
            {m.nav_home()}
          </Link>
          <Link to="/discover" className="hover:text-foreground hover:underline">
            {m.nav_discover()}
          </Link>
          <Link to="/privacy" className="hover:text-foreground hover:underline">
            {m.legal_privacy_policy()}
          </Link>
          <Link to="/terms" className="hover:text-foreground hover:underline">
            {m.legal_terms_of_service()}
          </Link>
          <Link to="/mentions-legales" className="hover:text-foreground hover:underline">
            {m.legal_notice()}
          </Link>
          <AnalyticsPreferencesButton className="hover:text-foreground hover:underline" />
          <Suspense fallback={<span aria-hidden="true" className="inline-flex h-8 min-w-32" />}>
            <FooterLocaleMenu />
          </Suspense>
        </div>
      </div>
    </footer>
  );
}
