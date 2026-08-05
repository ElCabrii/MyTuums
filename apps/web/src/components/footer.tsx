import { lazy, Suspense } from "react";
import { Link } from "@tanstack/react-router";
import { m } from "@/paraglide/messages.js";
import { APP_VERSION } from "@/lib/app-version";

// The locale switcher is the only interactive control in the footer and the
// only one that pulls in popover machinery (floating-ui + focus management);
// lazy-loading it keeps the wordmark and legal links static. `fallback={null}`
// is safe here because the footer's legal row has no fixed-size element —
// unlike the header's icon button, nothing shifts when the chunk mounts.
const FooterLocaleMenu = lazy(() =>
  import("@/components/footer-locale-menu").then((mod) => ({ default: mod.FooterLocaleMenu }))
);

/**
 * The site-wide footer: wordmark, copyright, legal links, and the lazy-loaded
 * locale switcher. Rendered by `__root.tsx` on every route, signed in or not.
 */
export function Footer() {
  return (
    <footer className="w-full border-t bg-background py-6 md:py-8 mt-auto">
      <div className="w-full flex flex-col md:flex-row items-center justify-between gap-4 px-4 sm:px-8 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <img
            src="/mytuums.svg"
            alt={m.app_logo_alt()}
            width={2048}
            height={2048}
            className="h-5 w-auto"
          />
          <span className="font-semibold text-foreground">MyTuums</span>
          <span className="text-xs">{`v${APP_VERSION}`}</span>
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
          <Suspense fallback={null}>
            <FooterLocaleMenu />
          </Suspense>
        </div>
      </div>
    </footer>
  );
}
