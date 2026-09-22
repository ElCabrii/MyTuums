import type { ConversationItem } from "@/lib/orpc";
import { m } from "@/paraglide/messages.js";

/** The inbox and request list use the same media-only and tombstone labels. */
export function messagePreview(last: ConversationItem["lastMessage"]) {
  if (last === null) return m.messages_empty_preview();
  if (last.encrypted) return m.messages_encrypted_preview();
  if (last.body === null) return m.messages_tombstone();
  if (last.body) return last.body;
  switch (last.mediaKind) {
    case "image":
      return m.messages_preview_photo();
    case "voice":
      return m.messages_preview_voice();
    case "video":
      return m.messages_preview_video();
    default:
      return m.messages_empty_preview();
  }
}
