import {
  Gamepad2,
  Heart,
  MessageCircle,
  Repeat2,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
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

/** The six-card feature grid — one lucide icon, one title, one sentence each. */
export function Features() {
  return (
    <section id="features" className="border-border/60 scroll-mt-14 border-t">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
        <p className="text-primary text-sm font-medium">{m.features_kicker()}</p>
        <h2 className="mt-2 text-3xl font-bold tracking-tight text-balance sm:text-4xl">
          {m.features_title()}
        </h2>
        <p className="text-muted-foreground mt-3 max-w-2xl text-pretty">{m.features_subtitle()}</p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <Card key={title()} className="p-6">
              <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-lg">
                <Icon className="size-5" />
              </div>
              <h3 className="mt-4 font-semibold">{title()}</h3>
              <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{text()}</p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
