import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { AtSign, Check, Loader2 } from "lucide-react";
import { authPendingAtom } from "@/atoms/auth";
import { changeHandleAtom, handleChangeDraftAtom, resetHandleChangeAtom } from "@/atoms/account";
import { viewerAtom, viewerHandleAtom } from "@/atoms/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Section } from "@/components/settings/section";
import { m } from "@/paraglide/messages.js";

/**
 * Changing the @handle.
 *
 * The warning is not decoration. Every profile URL, every link anyone has ever
 * shared, and the `user.byUsername` cache key are all derived from this one
 * column — changing it silently 404s the old address for everybody else. There
 * is no redirect from the old handle to the new one and no reservation of it,
 * so somebody else can claim it immediately afterwards.
 */
export function HandleSection() {
  const navigate = useNavigate();
  const viewer = useAtomValue(viewerAtom);
  const currentHandle = useAtomValue(viewerHandleAtom);
  const [draft, setDraft] = useAtom(handleChangeDraftAtom);
  const isBusy = useAtomValue(authPendingAtom);

  const changeHandle = useSetAtom(changeHandleAtom);
  const reset = useSetAtom(resetHandleChangeAtom);
  useEffect(() => reset, [reset]);

  const handleSubmit = async () => {
    const next = await changeHandle();
    // Only on success, and only to the *normalised* handle the action read back
    // off the refreshed session — the URL the profile now actually lives at.
    if (next) void navigate({ to: "/@{$username}", params: { username: next } });
  };

  return (
    <Section
      title={m.settings_handle_title()}
      description={m.settings_handle_description()}
      icon={<AtSign className="h-5 w-5" />}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
      >
        <div className="space-y-2">
          <label
            htmlFor="account-handle"
            className="text-muted-foreground text-xs font-semibold tracking-wider uppercase"
          >
            {m.auth_field_username()}
          </label>
          <div className="relative">
            <AtSign className="text-muted-foreground absolute top-3 left-3.5 h-4 w-4" />
            <Input
              id="account-handle"
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={viewer?.displayUsername ?? currentHandle ?? ""}
              className="bg-background/50 h-10 pl-10"
              autoComplete="username"
            />
          </div>
          <p className="text-muted-foreground text-xs">{m.welcome_handle_hint()}</p>
          <p className="text-destructive/90 text-xs">{m.settings_handle_warning()}</p>
        </div>

        <Button
          type="submit"
          size="sm"
          className="gap-2 rounded-full"
          disabled={isBusy || draft.trim().length === 0}
        >
          {isBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          {m.settings_handle_submit()}
        </Button>
      </form>
    </Section>
  );
}
