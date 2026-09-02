import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages.js";
import { signInUrl, signUpUrl } from "@/lib/site";

/** The hero: the tagline, the two entry points into the app, and a mock post. */
export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Decorative wash — a primary-tinted glow behind the headline, the
          only flourish the page carries. pointer-events-none so it can never
          eat a click on the CTAs it sits behind. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[36rem] bg-[radial-gradient(60%_50%_at_50%_0%,oklch(from_var(--primary)_l_c_h/0.14),transparent)]"
      />
      <div className="mx-auto w-full max-w-6xl px-4 pt-20 pb-20 text-center sm:px-6 sm:pt-28">
        <p className="border-border/60 bg-card text-muted-foreground mx-auto mb-5 inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium">
          {m.hero_badge()}
        </p>
        <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-tight text-balance sm:text-6xl">
          {m.hero_title_a()} <span className="text-primary">{m.hero_title_b()}</span>
        </h1>
        <p className="text-muted-foreground mx-auto mt-6 max-w-2xl text-base text-pretty sm:text-lg">
          {m.hero_subtitle()}
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button size="lg" render={<a href={signUpUrl} />}>
            {m.hero_cta_primary()}
          </Button>
          <Button size="lg" variant="outline" render={<a href={signInUrl} />}>
            {m.hero_cta_secondary()}
          </Button>
        </div>
        {/* A real screen of the app — a post quoting another post. The
            intrinsic size keeps the layout stable while the image loads. */}
        <img
          src="/shots/quote.webp"
          alt={m.shot_quote_alt()}
          width={719}
          height={808}
          className="border-border/60 mx-auto mt-16 w-full max-w-lg rounded-xl border shadow-2xl shadow-black/20"
        />
      </div>
    </section>
  );
}
