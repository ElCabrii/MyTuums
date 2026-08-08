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
  import("@/components/footer-locale-menu").then((mod) => ({ default: mod.FooterLocaleMenu })),
);

/**
 * The site-wide footer: wordmark, copyright, legal links, and the lazy-loaded
 * locale switcher. Rendered by `__root.tsx` on every route, signed in or not.
 */
export function Footer() {
  return (
    <footer className="bg-background mt-auto w-full border-t py-6 md:py-8">
      <div className="text-muted-foreground flex w-full flex-col items-center justify-between gap-4 px-4 text-sm sm:px-8 md:flex-row">
        <div className="flex items-center gap-2">
          <img
            src="/mytuums.svg"
            alt={m.app_logo_alt()}
            width={2048}
            height={2048}
            className="h-5 w-auto"
          />
          <span className="text-foreground font-semibold">MyTuums</span>
          <span className="text-xs">{`v${APP_VERSION}`}</span>
          <span>{m.footer_copyright({ year: String(new Date().getFullYear()) })}</span>
        </div>
        <div className="flex flex-wrap items-center gap-4 sm:gap-6">
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
          <Suspense fallback={null}>
            <FooterLocaleMenu />
          </Suspense>
        </div>
      </div>
    </footer>
  );
}
