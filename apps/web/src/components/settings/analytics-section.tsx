import { ChartNoAxesCombined } from "lucide-react";
import { useAtomValue, useSetAtom } from "jotai";
import { analyticsConsentAtom, analyticsPreferencesOpenAtom } from "@/atoms/analytics-consent";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/settings/section";
import { ANALYTICS_MEASUREMENT_ID } from "@/lib/analytics-config";
import { m } from "@/paraglide/messages.js";

export function AnalyticsSection() {
  if (!ANALYTICS_MEASUREMENT_ID) return null;

  return <ConfiguredAnalyticsSection />;
}

function ConfiguredAnalyticsSection() {
  const consent = useAtomValue(analyticsConsentAtom);
  const openPreferences = useSetAtom(analyticsPreferencesOpenAtom);

  const status =
    consent === "granted"
      ? m.analytics_status_granted()
      : consent === "denied"
        ? m.analytics_status_denied()
        : m.analytics_status_unset();

  return (
    <Section
      title={m.analytics_settings_title()}
      description={m.analytics_settings_description()}
      icon={<ChartNoAxesCombined className="h-5 w-5" />}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">{status}</p>
        <Button variant="outline" onClick={() => openPreferences(true)}>
          {m.analytics_manage()}
        </Button>
      </div>
    </Section>
  );
}
