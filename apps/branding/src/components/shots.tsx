import { m } from "@/paraglide/messages.js";

/**
 * The product band between the feature list and the closing CTA: two real
 * screens of the app, side by side. Real pixels over mockups — the feed with
 * its composer and the threaded conversation are the product's own proof.
 * `width`/`height` keep the layout stable while the lazy images load.
 */
export function Shots() {
  return (
    <section className="border-border/60 border-t">
      <div className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-20 sm:px-6 md:grid-cols-2 md:gap-6">
        <img
          src="/shots/feed.webp"
          alt={m.shot_feed_alt()}
          width={719}
          height={839}
          loading="lazy"
          className="border-border/60 w-full rounded-xl border shadow-2xl shadow-black/20"
        />
        <img
          src="/shots/thread.webp"
          alt={m.shot_thread_alt()}
          width={719}
          height={830}
          loading="lazy"
          className="border-border/60 w-full rounded-xl border shadow-2xl shadow-black/20"
        />
      </div>
    </section>
  );
}
