import { atomWithMutation, queryClientAtom } from "jotai-tanstack-query";
import { client, orpc } from "@/lib/orpc";
import { viewerIdAtom } from "@/atoms/session";
import { revokeMessageAccess, setMessageDraft } from "@/atoms/messages";
import { clearVideoDraft } from "@/atoms/video-upload";

/** One group command, with viewer-owned completion just like direct-message mutations. */
type GroupCommand =
  | { action: "create"; name: string; recipientIds: string[] }
  | { action: "invite"; conversationId: string; userId: string }
  | { action: "join"; conversationId: string; confirmBlocked?: boolean }
  | { action: "rename"; conversationId: string; name: string }
  | { action: "leave"; conversationId: string }
  | { action: "remove"; conversationId: string; userId: string };

export const groupCommandAtom = atomWithMutation<
  { conversationId: string; requiresConfirmation?: boolean },
  GroupCommand,
  Error,
  { viewerId: string | undefined }
>((get) => {
  const queryClient = get(queryClientAtom);
  return {
    mutationFn: async (
      command: GroupCommand,
    ): Promise<{ conversationId: string; requiresConfirmation?: boolean }> => {
      switch (command.action) {
        case "create":
          return client.message.createGroup(command);
        case "invite":
          return client.message.invite(command);
        case "join":
          return client.message.join(command);
        case "rename":
          return client.message.renameGroup(command);
        case "leave":
          return client.message.leaveGroup(command);
        case "remove":
          return client.message.removeMember(command);
      }
    },
    onMutate: () => ({ viewerId: get(viewerIdAtom) }),
    onSuccess: (result, command, context) => {
      if (
        !context?.viewerId ||
        get(viewerIdAtom) !== context.viewerId ||
        result.requiresConfirmation
      )
        return;
      if (
        command.action === "leave" ||
        (command.action === "remove" && command.userId === context.viewerId)
      ) {
        clearGroupDraft(result.conversationId);
        void queryClient.resetQueries({
          queryKey: orpc.message.thread.key({ input: { conversationId: result.conversationId } }),
        });
      }
      void queryClient.invalidateQueries({ queryKey: orpc.message.key() });
    },
  };
});

export function clearGroupDraft(conversationId: string) {
  revokeMessageAccess();
  setMessageDraft(`group:${conversationId}`, "");
  clearVideoDraft(`message:group:${conversationId}`);
}
