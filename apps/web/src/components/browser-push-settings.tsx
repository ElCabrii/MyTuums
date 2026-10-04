import { useAtomValue } from "jotai";
import { browserPushAtom, toggleBrowserPushAtom } from "@/atoms/browser-push";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages.js";

export function BrowserPushSettings() {
  const state = useAtomValue(browserPushAtom);
  const toggle = useAtomValue(toggleBrowserPushAtom);
  const data = state.data;
  const blocked = data?.permission === "denied";
  return (
    <section className="rounded-xl border p-4" aria-label={m.push_title()}>
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-sm font-semibold">{m.push_title()}</h2>
          <p className="text-muted-foreground text-xs">
            {data?.enabled ? m.push_enabled() : m.push_description()}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={
            !data?.supported ||
            (!data.publicKey && !data.enabled) ||
            (blocked && !data.enabled) ||
            toggle.isPending ||
            state.isPending
          }
          onClick={() => toggle.mutate(!data?.enabled)}
        >
          {toggle.isPending ? m.push_pending() : data?.enabled ? m.push_disable() : m.push_enable()}
        </Button>
      </div>
      {data && !data.supported && (
        <p className="text-muted-foreground mt-3 text-xs">{m.push_unsupported()}</p>
      )}
      {blocked && <p className="text-muted-foreground mt-3 text-xs">{m.push_blocked()}</p>}
      {data?.supported && !data.publicKey && !blocked && (
        <p className="text-muted-foreground mt-3 text-xs">{m.push_unavailable()}</p>
      )}
      {(state.isError || toggle.isError) && (
        <p role="alert" className="text-destructive mt-3 text-xs">
          {m.push_error()}
        </p>
      )}
    </section>
  );
}
