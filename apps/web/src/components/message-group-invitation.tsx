import { useState } from "react";
import { useAtomValue } from "jotai";
import { useNavigate } from "@tanstack/react-router";
import { groupCommandAtom } from "@/atoms/message-groups";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { m } from "@/paraglide/messages.js";

export function JoinGroupButton({ conversationId }: { conversationId: string }) {
  const command = useAtomValue(groupCommandAtom);
  const [warning, setWarning] = useState(false);
  const [error, setError] = useState(false);
  const navigate = useNavigate();
  const join = (confirmBlocked: boolean) => {
    setError(false);
    command.mutate(
      { action: "join", conversationId, confirmBlocked },
      {
        onSuccess: (result) => {
          if (result.requiresConfirmation) setWarning(true);
          else {
            setWarning(false);
            void navigate({ to: "/messages/$conversationId", params: { conversationId } });
          }
        },
        onError: () => setError(true),
      },
    );
  };
  return (
    <>
      <Button size="sm" disabled={command.isPending} onClick={() => join(false)}>
        {m.groups_join()}
      </Button>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {m.groups_join_error()}
        </p>
      )}
      <Dialog open={warning} onOpenChange={setWarning}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{m.groups_blocked_title()}</DialogTitle>
            <DialogDescription>{m.groups_blocked_warning()}</DialogDescription>
          </DialogHeader>
          <Button disabled={command.isPending} onClick={() => join(true)}>
            {m.groups_join_anyway()}
          </Button>
          <Button variant="secondary" onClick={() => setWarning(false)}>
            {m.common_cancel()}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
