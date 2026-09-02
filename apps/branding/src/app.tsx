import { SiteHeader } from "@/components/site-header";
import { Hero } from "@/components/hero";
import { Features } from "@/components/features";
import { Shots } from "@/components/shots";
import { CtaBand } from "@/components/cta-band";
import { SiteFooter } from "@/components/site-footer";

/** The branding site: one page, six sections, no router. */
export function App() {
  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <Hero />
        <Features />
        <Shots />
        <CtaBand />
      </main>
      <SiteFooter />
    </div>
  );
}
