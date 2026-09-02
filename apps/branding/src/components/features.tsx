import {
  Gamepad2,
  Heart,
  MessageCircle,
  Repeat2,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { m } from "@/paraglide/messages.js";

interface Feature {
  icon: LucideIcon;
  title: () => string;
  text: () => string;
}

const FEATURES: readonly Feature[] = [
  { icon: MessageCircle, title: m.feature_posts_title, text: m.feature_posts_text },
  { icon: Heart, title: m.feature_engagement_title, text: m.feature_engagement_text },
  { icon: Repeat2, title: m.feature_reposts_title, text: m.feature_reposts_text },
  { icon: Users, title: m.feature_follows_title, text: m.feature_follows_text },
  { icon: ShieldCheck, title: m.feature_moderation_title, text: m.feature_moderation_text },
  { icon: Gamepad2, title: m.feature_identity_title, text: m.feature_identity_text },
];

/**
 * The feature list — a spec sheet, not a card grid. One row per feature,
 * divided by hairlines, with the icon column and the title column at fixed
 * widths so the eye can scan either column independently.
 */
export function Features() {
  return (
    <section id="features" className="border-border/60 scroll-mt-14 border-t">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
        <p className="text-primary text-sm font-medium">{m.features_kicker()}</p>
        <h2 className="mt-2 text-3xl font-bold tracking-tight text-balance sm:text-4xl">
          {m.features_title()}
        </h2>
        <p className="text-muted-foreground mt-3 max-w-2xl text-pretty">{m.features_subtitle()}</p>
        <ul className="divide-border/60 border-border/60 mt-10 divide-y border-y">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <li key={title()} className="flex gap-4 py-5 sm:gap-6 sm:py-6">
              <Icon aria-hidden="true" className="text-primary mt-0.5 size-5 shrink-0" />
              <div className="min-w-0 sm:flex sm:w-full sm:items-baseline sm:gap-6">
                <h3 className="shrink-0 font-semibold sm:w-64">{title()}</h3>
                <p className="text-muted-foreground mt-1 text-sm leading-relaxed sm:mt-0">
                  {text()}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
