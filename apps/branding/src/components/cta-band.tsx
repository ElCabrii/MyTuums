import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages.js";
import { signInUrl, signUpUrl } from "@/lib/site";

/** The closing band: the page's one saturated surface and its final ask. */
export function CtaBand() {
  return (
    <section className="border-border/60 border-t">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
        <div className="bg-primary text-primary-foreground rounded-4xl px-6 py-14 text-center sm:px-12">
          <h2 className="text-3xl font-bold tracking-tight text-balance sm:text-4xl">
            {m.cta_title()}
          </h2>
          <p className="text-primary-foreground/80 mt-3 text-pretty">{m.cta_text()}</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button
              size="lg"
              variant="secondary"
              className="bg-background text-foreground hover:bg-background/90"
              render={<a href={signUpUrl} />}
            >
              {m.cta_button()}
            </Button>
            <Button
              size="lg"
              variant="ghost"
              className="text-primary-foreground hover:bg-primary-foreground/10"
              render={<a href={signInUrl} />}
            >
              {m.cta_sign_in()}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
