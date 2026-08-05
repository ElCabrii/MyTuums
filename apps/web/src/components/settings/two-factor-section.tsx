import { useAtom, useAtomValue, useSetAtom } from "jotai";
import QRCode from "react-qr-code";
import { Check, Loader2, ShieldCheck } from "lucide-react";
import { authPendingAtom } from "@/atoms/auth";
import { viewerAtom } from "@/atoms/session";
import {
  disableTwoFactorAtom,
  openTwoFactorPanelAtom,
  startTwoFactorSetupAtom,
  twoFactorCodeAtom,
  twoFactorPanelAtom,
  twoFactorPasswordAtom,
  twoFactorSetupAtom,
  verifyTwoFactorAtom,
} from "@/atoms/two-factor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Section } from "@/components/settings/section";
import { m } from "@/paraglide/messages.js";

/**
 * The settings card for enrolling, verifying and disabling two-factor. Shares
 * its panel atoms with the `/welcome` one-time offer (see `TwoFactorOffer` in
 * routes/welcome.tsx) so the two enrolments cannot drift.
 */
export function TwoFactorSection() {
  const viewer = useAtomValue(viewerAtom);
  const panel = useAtomValue(twoFactorPanelAtom);
  const openPanel = useSetAtom(openTwoFactorPanelAtom);
  const [password, setPassword] = useAtom(twoFactorPasswordAtom);
  const [code, setCode] = useAtom(twoFactorCodeAtom);
  const setup = useAtomValue(twoFactorSetupAtom);
  const isBusy = useAtomValue(authPendingAtom);

  const startSetup = useSetAtom(startTwoFactorSetupAtom);
  const disable = useSetAtom(disableTwoFactorAtom);
  const verify = useSetAtom(verifyTwoFactorAtom);

  const enabled = Boolean(viewer?.twoFactorEnabled);

  const handleEnable = async () => {
    if (await startSetup()) openPanel("verify");
  };

  const handleVerify = async () => {
    // The same action the sign-in challenge uses — enrolment confirmation and
    // a login challenge post to the identical endpoint. BetterAuth only flips
    // `twoFactorEnabled` once one of them succeeds, which is what stops
    // somebody locking themselves out with a secret they never scanned.
    if (await verify("totp")) openPanel("idle");
  };

  const handleDisable = async () => {
    if (await disable()) openPanel("idle");
  };

  return (
    <Section
      title={m.twofa_section_title()}
      description={enabled ? m.twofa_section_on() : m.twofa_section_off()}
      icon={<ShieldCheck className="h-5 w-5" />}
    >
      {panel === "idle" && (
        <Button
          variant={enabled ? "outline" : "default"}
          size="sm"
          className="rounded-full"
          disabled={isBusy}
          onClick={() => openPanel(enabled ? "disable" : "enable")}
        >
          {enabled ? m.twofa_disable() : m.twofa_enable()}
        </Button>
      )}

      {(panel === "enable" || panel === "disable") && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void (panel === "enable" ? handleEnable() : handleDisable());
          }}
        >
          <div className="space-y-2">
            <label htmlFor="twofa-password" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {m.auth_field_password()}
            </label>
            <Input
              id="twofa-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="h-10 bg-background/50"
              required
            />
            <p className="text-xs text-muted-foreground">{m.twofa_password_hint()}</p>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" className="rounded-full gap-2" disabled={isBusy}>
              {isBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {panel === "enable" ? m.twofa_enable() : m.twofa_disable()}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={() => openPanel("idle")}>
              {m.common_cancel()}
            </Button>
          </div>
        </form>
      )}

      {panel === "verify" && setup && (
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{m.twofa_scan_hint()}</p>
            {/* White plate regardless of theme: QR scanners need the light
                modules lighter than the dark ones, and a dark-mode card
                background behind a dark foreground is unreadable to them. */}
            <div className="bg-white p-4 rounded-2xl w-fit">
              <QRCode value={setup.totpURI} size={160} />
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {m.twofa_backup_codes()}
            </p>
            <p className="text-xs text-muted-foreground">{m.twofa_backup_codes_hint()}</p>
            <ul className="grid grid-cols-2 gap-1.5 font-mono text-xs bg-muted/40 rounded-2xl p-4">
              {setup.backupCodes.map((backupCode) => (
                <li key={backupCode}>{backupCode}</li>
              ))}
            </ul>
          </div>

          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void handleVerify();
            }}
          >
            <div className="space-y-2">
              <label htmlFor="twofa-code" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {m.twofa_field_code()}
              </label>
              <Input
                id="twofa-code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
                inputMode="numeric"
                className="h-10 bg-background/50 font-mono tracking-[0.3em]"
                required
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" className="rounded-full gap-2" disabled={isBusy}>
                {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                {m.twofa_confirm()}
              </Button>
              <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={() => openPanel("idle")}>
                {m.common_cancel()}
              </Button>
            </div>
          </form>
        </div>
      )}
    </Section>
  );
}
