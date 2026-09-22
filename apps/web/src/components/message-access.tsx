import type { ReactNode } from "react";
import { useState } from "react";
import { useAtomValue } from "jotai";
import { LockKeyhole } from "lucide-react";
import {
  messageAccessAtom,
  recoverMessageKeysAtom,
  requestMessageRecoveryAtom,
  setupMessageKeysAtom,
} from "@/atoms/message-access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { m } from "@/paraglide/messages.js";

export function MessageAccess({ children }: { children: ReactNode }) {
  const access = useAtomValue(messageAccessAtom);
  const setup = useAtomValue(setupMessageKeysAtom);
  const request = useAtomValue(requestMessageRecoveryAtom);
  const recover = useAtomValue(recoverMessageKeysAtom);
  const [code, setCode] = useState("");
  if (access.data?.local) return children;
  const existing = access.data?.identity !== null;
  const busy = access.isPending || setup.isPending || request.isPending || recover.isPending;
  const error = access.isError || setup.isError || request.isError || recover.isError;
  return (
    <section className="mx-auto flex w-full max-w-lg flex-col gap-4 px-6 py-12">
      <LockKeyhole className="size-8" aria-hidden="true" />
      <h1 className="text-xl font-semibold">{m.messages_encryption_title()}</h1>
      <p>{m.messages_encryption_disclosure()}</p>
      <p className="text-muted-foreground text-sm">{m.messages_encryption_device()}</p>
      {access.isPending && <p role="status">{m.messages_encryption_loading()}</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {m.messages_encryption_error()}
        </p>
      )}
      {!access.isPending && !access.data?.recovery && <p>{m.messages_encryption_unavailable()}</p>}
      {access.data?.recovery && !existing && (
        <Button disabled={busy} onClick={() => setup.mutate()}>
          {m.messages_encryption_enable()}
        </Button>
      )}
      {access.data?.recovery && existing && !request.data && (
        <Button disabled={busy} onClick={() => request.mutate()}>
          {m.messages_encryption_recover()}
        </Button>
      )}
      {request.data && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!request.data) return;
            recover.mutate(
              { code, request: request.data },
              {
                onSuccess: () => {
                  setCode("");
                  request.reset();
                },
              },
            );
          }}
        >
          <p>{m.messages_encryption_code_sent()}</p>
          <label htmlFor="message-recovery-code">{m.messages_encryption_code()}</label>
          <Input
            id="message-recovery-code"
            autoComplete="one-time-code"
            value={code}
            maxLength={16}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button type="submit" disabled={busy || !/^[a-f0-9]{16}$/i.test(code)}>
            {m.messages_encryption_unlock()}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => request.mutate()}>
            {m.messages_encryption_resend()}
          </Button>
        </form>
      )}
      {access.isError && (
        <Button variant="outline" onClick={() => void access.refetch()}>
          {m.common_try_again()}
        </Button>
      )}
    </section>
  );
}
