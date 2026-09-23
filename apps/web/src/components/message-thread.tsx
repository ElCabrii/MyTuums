import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { getLocale } from "@/paraglide/runtime.js";
import { toast } from "sonner";
import {
  ArrowLeft,
  EyeOff,
  Flag,
  Loader2,
  Mic,
  MoreHorizontal,
  Send,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  conversationWithFamily,
  deleteMessageAtom,
  hideConversationAtom,
  markThreadReadAtom,
  messageDraftFor,
  messageThreadFamily,
  seedFirstMessageThread,
  sendMessageAtom,
  setMessageDraft,
  type PendingMedia,
} from "@/atoms/messages";
import type { ThreadItem } from "@/atoms/messages";
import {
  clearVideoDraft,
  selectVideoAtomFamily,
  videoDraftAtomFamily,
  type VideoSelectionVerdict,
} from "@/atoms/video-upload";
import { viewerIdAtom } from "@/atoms/session";
import { reportDialogAtom } from "@/atoms/dialog-targets";
import type { ComposerAttachment } from "@/atoms/composer";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ComposerMediaDialog } from "@/components/composer-media-dialog";
import { ComposerVideo } from "@/components/composer-video";
import {
  MessageAttachments,
  VoiceBubble,
  TERMINAL_VIDEO_STATES,
} from "@/components/message-attachments";
import { LinkedText } from "@/components/linked-text";
import { formatRelativeTime } from "@/lib/format";
import { handleOf } from "@/lib/user";
import { createPostAttachment } from "@/lib/media";
import {
  createVoiceRecorder,
  formatVoiceDuration,
  voiceRecordingSupported,
  type VoiceRecorderHandle,
  type RecordedVoice,
} from "@/lib/voice-recorder";
import { preflightVideo, type VideoPreflightRejection } from "@/lib/video-preflight";
import { acceptPostImage } from "@my-tuums/api/post-image";
import {
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_IMAGE_MAX_BYTES,
  MESSAGE_IMAGE_MAX_COUNT,
  MESSAGE_IMAGE_MAX_TOTAL_BYTES,
  MESSAGE_VOICE_MAX_DURATION_MS,
  VIDEO_MAX_BYTES,
  VIDEO_MAX_DURATION_SECONDS,
  VIDEO_MAX_FPS,
  VIDEO_MAX_LONG_EDGE,
  VIDEO_MAX_SHORT_EDGE,
} from "@my-tuums/api/constants";
import type { ConversationItem } from "@/lib/orpc";
import { m } from "@/paraglide/messages.js";

/**
 * One open conversation (issue #408): bubbles oldest-to-newest, safe
 * linkification via `LinkedText` (the same component posts render through),
 * sender tombstones, per-message report and delete-own actions, the
 * Enter/Shift+Enter composer, and the read acknowledgment — which fires only
 * for a foregrounded thread, through the newest DISPLAYED message.
 */
export function MessageThreadPane({ conversationId }: { conversationId: string }) {
  const thread = useAtomValue(messageThreadFamily(conversationId));
  const viewerId = useAtomValue(viewerIdAtom);
  const markRead = useAtomValue(markThreadReadAtom);
  const hide = useAtomValue(hideConversationAtom);
  const navigate = useNavigate();
  // The newest message this view has acknowledged — the loop guard for the
  // effect below, which otherwise re-fires on every refetch.
  const acknowledged = useRef<string | null>(null);

  const messages: ThreadItem[] = useMemo(
    () => thread.data?.pages.flatMap((page) => page.items) ?? [],
    [thread.data],
  );
  const oldestFirst = [...messages].reverse();
  const header = thread.data?.pages[0];
  const other = header?.user ?? null;
  const handle = handleOf(other);
  const displayName = other?.name || handle || m.user_unknown();
  const lastReadAt = header?.lastReadAt ?? null;

  // A video attachment the workflow is still processing keeps the thread
  // polling until its state turns terminal: D1 is the source of truth, the
  // SSE push tells this client about OTHER events, and the refetch is what
  // flips the processing bubble into the player (a missed poll loses
  // nothing — the next one, or a focus refetch, lands the same state).
  const processingVideo = messages.some(
    (item) =>
      item.deletedAt === null &&
      (item.attachments ?? []).some(
        (attachment) =>
          attachment.video !== null && !TERMINAL_VIDEO_STATES.has(attachment.video.state),
      ),
  );
  const refetchThread = thread.refetch;
  useEffect(() => {
    if (!processingVideo) return;
    const timer = setInterval(() => void refetchThread(), 4000);
    return () => clearInterval(timer);
  }, [processingVideo, refetchThread]);

  // "Open and displayed means read" — but only while the document is
  // foregrounded and only through the newest message actually on screen (the
  // newest loaded one; the pane scrolls to it). A background tab must not
  // burn the reader's unread state.
  //
  // The sender does NOT gate this: the cursor advances through the newest
  // displayed message even when it is the viewer's own — `message.send`
  // never moves `lastReadAt`, so a reply sitting above an unacknowledged
  // incoming message must still clear it. The server accepts advancing
  // through an owned message.
  useEffect(() => {
    const newest = messages[0];
    if (
      !newest ||
      newest.pending ||
      newest.decryptionFailed ||
      document.visibilityState !== "visible" ||
      acknowledged.current === newest.id ||
      (lastReadAt !== null && newest.createdAt <= lastReadAt)
    ) {
      return;
    }
    acknowledged.current = newest.id;
    markRead.mutate({ conversationId, lastSeenMessageId: newest.id });
  }, [messages, lastReadAt, markRead, conversationId]);

  if (thread.isPending) {
    return <ThreadSkeleton />;
  }
  if (thread.isError) {
    return (
      <div className="text-muted-foreground flex h-full min-h-64 flex-col items-center justify-center gap-3 p-8">
        <p role="alert" className="text-destructive text-sm">
          {m.messages_load_error()}
        </p>
        <Button variant="secondary" onClick={() => void thread.refetch()}>
          {m.common_try_again()}
        </Button>
      </div>
    );
  }

  return (
    // Fills the bounded grid cell the /messages layout provides: the header
    // and composer are plain flex children and MessageScroll owns the only
    // scrolling inside the pane.
    <div className="flex h-full flex-col">
      <ThreadHeader
        displayName={displayName}
        handle={handle}
        image={other?.image ?? null}
        userId={other?.id ?? null}
        onHide={() =>
          hide.mutate(
            { conversationId },
            {
              onSuccess: () => {
                toast(m.messages_hidden());
                void navigate({ to: "/messages", replace: true });
              },
              onError: () => toast.error(m.messages_action_error()),
            },
          )
        }
        hidePending={hide.isPending}
      />
      {header?.hidden && (
        <p className="bg-muted/50 text-muted-foreground border-border flex items-center gap-2 border-b px-4 py-2 text-xs">
          <EyeOff className="size-3.5 shrink-0" aria-hidden="true" />
          {m.messages_hidden_notice()}
        </p>
      )}
      <p className="text-muted-foreground px-4 py-2 text-xs">{m.messages_encryption_notice()}</p>
      <MessageScroll
        items={oldestFirst}
        hasNextPage={thread.hasNextPage}
        isFetching={thread.isFetchingNextPage}
        onLoadMore={() => void thread.fetchNextPage()}
        viewerId={viewerId ?? ""}
      />
      <Composer key={other?.id} conversationId={conversationId} recipientId={other?.id ?? ""} />
    </div>
  );
}

function ThreadHeader({
  displayName,
  handle,
  image,
  userId,
  onHide,
  hidePending,
  canHide = true,
}: {
  displayName: string;
  handle: string | null;
  image: string | null;
  /** The other party — the target a "report user" files against. */
  userId: string | null;
  onHide: () => void;
  hidePending: boolean;
  canHide?: boolean;
}) {
  const setReport = useSetAtom(reportDialogAtom);

  return (
    // A plain flex child at the pane's top, never sticky: the /messages
    // layout bounds the pane to the visible area below the global header, so
    // this bar cannot scroll — and a sticky top offset here would shift it
    // DOWN into the pane (the overflow-hidden layout is a scrollport that
    // never scrolls, so the sticky constraint pushes instead of pins),
    // covering the first messages exactly as far as it moved.
    <header className="border-border bg-background flex items-center gap-3 border-b px-4 py-3">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        aria-label={m.messages_back()}
        render={<Link to="/messages" />}
      >
        <ArrowLeft className="h-5 w-5" aria-hidden="true" />
      </Button>
      <Avatar className="h-9 w-9 shrink-0">
        {image && <AvatarImage src={image} alt="" />}
        <AvatarFallback>{displayName.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        {handle ? (
          <Link
            to="/@{$username}"
            params={{ username: handle }}
            className="hover:text-primary truncate text-sm font-semibold no-underline"
          >
            {displayName}
          </Link>
        ) : (
          <span className="truncate text-sm font-semibold">{displayName}</span>
        )}
      </div>
      {/* The thread's overflow actions live behind one kebab, the same
          pattern as the profile's: reporting the other party (the shared
          user-report dialog) and, for an open conversation, hiding it. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={m.moderation_kebab()}
          title={m.moderation_kebab()}
          className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex h-9 w-9 cursor-pointer items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2"
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {userId && (
            <DropdownMenuItem
              className="cursor-pointer"
              onClick={() => setReport({ targetType: "user", targetId: userId })}
            >
              {m.messages_report_user()}
            </DropdownMenuItem>
          )}
          {canHide && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="cursor-pointer"
                variant="destructive"
                disabled={hidePending}
                onSelect={onHide}
              >
                {m.messages_hide()}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

/** What an optimistic row shows while its media group is in flight. */
function PendingMediaChip({ pendingMedia }: { pendingMedia: PendingMedia }) {
  return (
    <span className="text-muted-foreground/80 flex items-center gap-1.5 text-xs italic">
      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      {pendingMedia.kind === "images"
        ? `${m.messages_preview_photo()} ×${pendingMedia.count}`
        : pendingMedia.kind === "voice"
          ? m.messages_preview_voice()
          : m.messages_preview_video()}
    </span>
  );
}

function MessageScroll({
  items,
  hasNextPage,
  isFetching,
  onLoadMore,
  viewerId,
}: {
  items: ThreadItem[];
  hasNextPage: boolean;
  isFetching: boolean;
  onLoadMore: () => void;
  viewerId: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const previousCount = useRef(0);
  const locale = getLocale();

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // Stay pinned to the newest message while the reader is at (or near) the
    // bottom; never yank them down while they read history above it.
    if (pinned.current) element.scrollTop = element.scrollHeight;
    previousCount.current = items.length;
  }, [items]);

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
      className="flex-1 space-y-1 overflow-y-auto px-4 py-4"
    >
      {hasNextPage && (
        <div className="flex justify-center pb-2">
          <Button variant="ghost" size="sm" disabled={isFetching} onClick={onLoadMore}>
            {isFetching ? m.messages_loading() : m.messages_load_older()}
          </Button>
        </div>
      )}
      {items.map((item) => {
        const mine = item.senderId === viewerId;
        return (
          <div key={item.id} className={`group flex ${mine ? "justify-end" : "justify-start"}`}>
            {item.deletedAt !== null ? (
              <p className="text-muted-foreground my-1 self-center text-xs italic">
                {m.messages_tombstone()}
              </p>
            ) : (
              <div
                className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                  mine
                    ? "bg-primary text-primary-foreground rounded-br-sm"
                    : "bg-muted text-foreground rounded-bl-sm"
                }`}
              >
                {item.pending && item.pendingMedia ? (
                  <PendingMediaChip pendingMedia={item.pendingMedia} />
                ) : (
                  <MessageAttachments attachments={item.attachments ?? []} mine={mine} />
                )}
                {(item.body ?? "").length > 0 && (
                  <>
                    {item.attachments && item.attachments.length > 0 && !item.pending && (
                      <div className="pt-1" />
                    )}
                    <LinkedText text={item.body ?? ""} />
                  </>
                )}
                {item.decryptionFailed && <p role="alert">{m.messages_decryption_error()}</p>}
                {!item.envelope && !item.pending && (
                  <p className="text-xs opacity-70">{m.messages_legacy_notice()}</p>
                )}
                <span
                  className={`mt-0.5 block text-right text-[10px] ${
                    mine ? "text-primary-foreground/70" : "text-muted-foreground"
                  }`}
                >
                  {formatRelativeTime(item.createdAt, locale, m.post_just_now())}
                </span>
              </div>
            )}
            {/* A permanently reserved action column: the icon fades in beside
                the bubble on hover or keyboard focus, and the message never
                moves — an element appearing in the flex flow would shove the
                bubble sideways the moment it renders. */}
            <div className="text-muted-foreground ml-1 flex w-7 shrink-0 items-center justify-center self-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
              {mine && item.deletedAt === null && <DeleteOwnAction messageId={item.id} />}
              {!mine &&
                item.deletedAt === null &&
                (!item.decryptionFailed || item.attachments.length > 0) && (
                  <ReportMessageAction
                    messageId={item.id}
                    body={item.body}
                    disclosure={item.disclosure}
                    attachments={item.attachments}
                  />
                )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DeleteOwnAction({ messageId }: { messageId: string }) {
  const remove = useAtomValue(deleteMessageAtom);
  return (
    <button
      type="button"
      aria-label={m.messages_delete()}
      title={m.messages_delete()}
      disabled={remove.isPending}
      onClick={() =>
        remove.mutate(
          { messageId },
          {
            onError: () => {
              toast.error(m.messages_action_error());
              remove.reset();
            },
          },
        )
      }
      className="hover:text-destructive rounded p-1 transition-colors"
    >
      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

function ReportMessageAction({
  messageId,
  body,
  disclosure,
  attachments,
}: {
  messageId: string;
  body: string | null;
  disclosure?: string;
  attachments: ThreadItem["attachments"];
}) {
  const setReport = useSetAtom(reportDialogAtom);
  return (
    <button
      type="button"
      aria-label={m.moderation_report_title_message()}
      title={m.moderation_report_title_message()}
      onClick={() =>
        setReport({
          targetType: "message",
          targetId: messageId,
          body,
          disclosure,
          attachments,
        })
      }
      className="hover:text-destructive rounded p-1 transition-colors"
    >
      <Flag className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

/**
 * Reads selected bytes through the browser's FileReader contract (jsdom
 * included) so the shared image acceptance can sniff what the user picked.
 */
function readFileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(new Uint8Array(reader.result));
      else reject(new Error("Unable to read the selected image."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read the selected image."));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * The message composer: Enter sends, and the one media GROUP a message may
 * carry is chosen here — up to four images through the shared picker and
 * re-encode pipeline, one video through the shared Stream upload state, or
 * one recorded voice note. Media state is transient (the text draft is the
 * only persisted one), keyed by recipient via the component's recipientId.
 */
function Composer({
  recipientId,
  conversationId,
  seedUser,
}: {
  recipientId: string;
  /** The open thread the composer sits in, when there is one. */
  conversationId?: string;
  /** The recipient's summary — lets a first contact seed the new thread. */
  seedUser?: ConversationItem["user"] | null;
}) {
  const [draft, setDraft] = useState(() => messageDraftFor(recipientId));
  const send = useAtomValue(sendMessageAtom);
  const navigate = useNavigate();
  const queryClient = useAtomValue(queryClientAtom);

  // Images: the same ComposerAttachment objects and re-encode pipeline the
  // post composer runs, so EXIF stripping and byte caps behave identically.
  const [images, setImages] = useState<ComposerAttachment[]>([]);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const imageSelectionRef = useRef(0);

  // Video: the post composer's upload atoms, scoped to THIS recipient so two
  // drafts never share state. The draft survives remounts of the pane.
  const videoScope = `message:${recipientId}`;
  const videoDraft = useAtomValue(videoDraftAtomFamily(videoScope));
  const selectVideo = useSetAtom(selectVideoAtomFamily(videoScope));
  const videoReady = videoDraft?.status === "uploaded" && Boolean(videoDraft.videoId);

  // Voice: transient recording state; the finished note waits in a draft
  // chip until send or removal.
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [voiceDraft, setVoiceDraft] = useState<RecordedVoice | null>(null);
  const recorderRef = useRef<VoiceRecorderHandle | null>(null);
  useEffect(
    () => () => {
      imageSelectionRef.current += 1;
      recorderRef.current?.cancel();
    },
    [],
  );

  const videoRejectionMessage = (reason: VideoPreflightRejection): string => {
    switch (reason) {
      case "size":
        return m.video_reject_size({ maxMb: String(VIDEO_MAX_BYTES / 1_000_000) });
      case "type":
        return m.video_reject_type();
      case "duration":
        return m.video_reject_duration({ maxMinutes: String(VIDEO_MAX_DURATION_SECONDS / 60) });
      case "dimensions":
        return m.video_reject_dimensions({
          longEdge: String(VIDEO_MAX_LONG_EDGE),
          shortEdge: String(VIDEO_MAX_SHORT_EDGE),
        });
      case "frameRate":
        return m.video_reject_frame_rate({ maxFps: String(VIDEO_MAX_FPS) });
      case "unreadable":
        return m.video_reject_unreadable();
    }
  };

  const editDraft = (body: string) => {
    setDraft(body);
    setMessageDraft(recipientId, body);
  };

  const startRecording = async () => {
    if (recorderRef.current || recording) return;
    const handle = createVoiceRecorder({
      maxDurationMs: MESSAGE_VOICE_MAX_DURATION_MS,
      onEvent: (event) => {
        switch (event.kind) {
          case "recording":
            setRecording(true);
            setElapsedMs(0);
            break;
          case "tick":
            setElapsedMs(event.elapsedMs);
            break;
          case "stopped":
            setRecording(false);
            recorderRef.current = null;
            setVoiceDraft(event.voice);
            break;
          case "cancelled":
            setRecording(false);
            recorderRef.current = null;
            break;
          case "failed":
            setRecording(false);
            recorderRef.current = null;
            toast.error(
              event.reason === "unsupported"
                ? m.messages_voice_unsupported()
                : m.messages_voice_failed(),
            );
            break;
        }
      },
    });
    recorderRef.current = handle;
    setRecording(true);
    await handle.start();
  };

  const stopRecording = () => {
    // `stopped` clears the ref; cancel keeps the same shape.
    recorderRef.current?.stop();
  };

  const cancelRecording = () => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setRecording(false);
  };

  const removeVoiceDraft = () => {
    setVoiceDraft(null);
  };

  const handleMediaSelection = async (files: File[]) => {
    if (validating || recording || voiceDraft) return;
    const video = files.find((file) => file.type.startsWith("video/"));
    if (video) {
      if (files.length !== 1 || images.length > 0 || videoDraft) {
        setMediaError(m.post_media_hint());
        return;
      }
      setMediaError(null);
      setValidating(true);
      let verdict: VideoSelectionVerdict;
      try {
        verdict = await selectVideo(video, preflightVideo);
      } finally {
        setValidating(false);
      }
      setMediaError(verdict.accepted ? null : videoRejectionMessage(verdict.reason));
      return;
    }
    if (videoDraft) {
      setMediaError(m.post_media_hint());
      return;
    }
    const selectionId = imageSelectionRef.current + 1;
    imageSelectionRef.current = selectionId;
    setMediaError(null);
    setValidating(true);
    const next = [...images];
    let totalBytes = next.reduce((sum, attachment) => sum + attachment.file.size, 0);
    let nextError: string | null = null;
    for (const file of files) {
      if (file.size <= 0 || file.size > MESSAGE_IMAGE_MAX_BYTES) {
        nextError ??= m.post_image_invalid();
        continue;
      }
      if (next.length >= MESSAGE_IMAGE_MAX_COUNT) {
        nextError = m.post_image_limit();
        break;
      }
      let accepted: boolean;
      try {
        accepted = acceptPostImage(await readFileBytes(file), file.type).ok;
      } catch {
        accepted = false;
      }
      if (!accepted) {
        nextError ??= m.post_image_invalid();
        continue;
      }
      let processed: File;
      try {
        processed = await createPostAttachment(file);
      } catch {
        nextError ??= m.post_image_invalid();
        continue;
      }
      if (totalBytes + processed.size > MESSAGE_IMAGE_MAX_TOTAL_BYTES) {
        nextError = m.post_image_limit();
        break;
      }
      next.push({ id: crypto.randomUUID(), file: processed });
      totalBytes += processed.size;
    }
    if (selectionId !== imageSelectionRef.current) return;
    if (nextError) setMediaError(nextError);
    setImages(next);
    setValidating(false);
  };

  const hasMedia = images.length > 0 || voiceDraft !== null || videoReady;
  const canSubmit =
    (draft.trim().length > 0 || hasMedia) &&
    !send.isPending &&
    !validating &&
    !recording &&
    (!videoDraft || videoReady);

  const clearMedia = () => {
    setImages([]);
    removeVoiceDraft();
    clearVideoDraft(videoScope);
    setMediaError(null);
  };

  const submit = () => {
    const body = draft.trim();
    if (!canSubmit || (!body && !hasMedia)) return;
    editDraft("");
    send.mutate(
      {
        recipientId,
        body,
        conversationId,
        images: images.length > 0 ? images.map((attachment) => attachment.file) : undefined,
        voice: voiceDraft?.file,
        voiceDurationMs: voiceDraft?.durationMs,
        videoId: videoReady && videoDraft?.videoId ? videoDraft.videoId : undefined,
      },
      {
        onSuccess: (message) => {
          clearMedia();
          if (!conversationId) {
            if (seedUser) {
              seedFirstMessageThread(queryClient, message.conversationId, seedUser, message);
            }
            void navigate({
              to: "/messages/$conversationId",
              params: { conversationId: message.conversationId },
              replace: true,
            });
          }
        },
        onError: (error) => {
          editDraft(body);
          toast.error(
            error.message === m.messages_recipient_not_ready()
              ? m.messages_recipient_not_ready()
              : m.messages_send_error(),
          );
          send.reset();
        },
      },
    );
  };

  return (
    // A plain flex child at the pane's bottom: the /messages layout bounds
    // the pane to the visible area, so the composer sits above the mobile
    // tab bar by construction — nothing scrolls under it.
    <footer className="border-border bg-background border-t p-3">
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((attachment) => (
            <MessageImageDraft
              key={attachment.id}
              attachment={attachment}
              disabled={send.isPending}
              onRemove={() =>
                setImages((current) => current.filter((item) => item.id !== attachment.id))
              }
            />
          ))}
        </div>
      )}
      {voiceDraft && (
        <div className="bg-muted/30 mb-2 flex items-center gap-2 rounded-lg p-2">
          <VoiceBubble file={voiceDraft.file} durationMs={voiceDraft.durationMs} mine={false} />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={m.messages_voice_remove()}
            disabled={send.isPending}
            onClick={removeVoiceDraft}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      )}
      {videoDraft && <ComposerVideo scope={videoScope} disabled={send.isPending} />}
      {recording && (
        <div
          className="bg-destructive/10 border-destructive/20 text-destructive mb-2 flex items-center gap-2 rounded-lg border p-2 text-sm"
          role="status"
        >
          <span
            className="bg-destructive size-2 shrink-0 animate-pulse rounded-full"
            aria-hidden="true"
          />
          <span className="flex-1 tabular-nums">{formatVoiceDuration(elapsedMs)}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={cancelRecording}
            aria-label={m.messages_voice_cancel()}
          >
            {m.messages_voice_cancel()}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={stopRecording}
            aria-label={m.messages_voice_stop()}
          >
            <Square className="size-3.5" aria-hidden="true" />
            {m.messages_voice_stop()}
          </Button>
        </div>
      )}
      {mediaError && (
        <div
          role="alert"
          className="bg-destructive/10 border-destructive/20 text-destructive mb-2 flex items-start gap-2 rounded-lg border p-2.5 text-xs"
        >
          <span>{mediaError}</span>
        </div>
      )}
      <div className="border-border focus-within:border-primary/50 flex items-end gap-2 rounded-2xl border p-2">
        <div className="flex items-center gap-1">
          <ComposerMediaDialog
            disabled={
              send.isPending ||
              recording ||
              validating ||
              Boolean(videoDraft) ||
              voiceDraft !== null ||
              images.length >= MESSAGE_IMAGE_MAX_COUNT
            }
            description={m.messages_media_hint()}
            hints={[
              m.messages_media_hint(),
              m.messages_voice_too_long({ minutes: String(MESSAGE_VOICE_MAX_DURATION_MS / 60000) }),
            ]}
            onSelect={(files) => void handleMediaSelection(files)}
          />
          {voiceRecordingSupported() && !voiceDraft && !videoDraft && images.length === 0 && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground rounded-full"
              aria-label={m.messages_voice_record()}
              title={m.messages_voice_record()}
              disabled={send.isPending || validating || recording}
              onClick={() => void startRecording()}
            >
              <Mic className="size-4" aria-hidden="true" />
            </Button>
          )}
        </div>
        <textarea
          value={draft}
          rows={1}
          disabled={send.isPending}
          maxLength={MESSAGE_BODY_MAX_LENGTH}
          onChange={(event) => editDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            // A composition session owns Enter (confirming the candidate);
            // sending under it would fire half-typed text.
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit();
          }}
          placeholder={m.messages_composer_placeholder()}
          aria-label={m.messages_composer_placeholder()}
          className="max-h-32 min-h-9 min-w-0 flex-1 resize-none bg-transparent px-2 text-sm outline-none"
        />
        <Button
          size="icon"
          className="rounded-full"
          aria-label={m.messages_send()}
          disabled={!canSubmit}
          onClick={submit}
        >
          {send.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      </div>
    </footer>
  );
}

/** Owns the preview URL for exactly one mounted image selection. */
function MessageImageDraft({
  attachment,
  disabled,
  onRemove,
}: {
  attachment: ComposerAttachment;
  disabled: boolean;
  onRemove: () => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const url = URL.createObjectURL(attachment.file);
    if (imageRef.current) imageRef.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [attachment.file]);
  return (
    <div className="relative">
      <img ref={imageRef} alt={attachment.file.name} className="size-16 rounded-lg object-cover" />
      <Button
        type="button"
        size="icon-xs"
        variant="secondary"
        aria-label={m.messages_attachment_remove()}
        disabled={disabled}
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 rounded-full"
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div className="flex h-full flex-col" aria-hidden>
      <div className="border-border flex items-center gap-3 border-b px-4 py-3">
        <Skeleton className="h-9 w-9 rounded-full motion-reduce:animate-none" />
        <Skeleton className="h-4 w-32 motion-reduce:animate-none" />
      </div>
      <div className="flex-1 space-y-3 p-4">
        <Skeleton className="h-10 w-1/2 rounded-2xl motion-reduce:animate-none" />
        <Skeleton className="ml-auto h-10 w-2/5 rounded-2xl motion-reduce:animate-none" />
        <Skeleton className="h-10 w-3/5 rounded-2xl motion-reduce:animate-none" />
      </div>
    </div>
  );
}

/**
 * The `/messages/new/$userId` pane: resolves an existing visible conversation
 * and moves to it, else offers the composer alone — the conversation is
 * created idempotently by the first send, never by a "start" step.
 */
export function NewMessagePane({ userId }: { userId: string }) {
  const lookup = useAtomValue(conversationWithFamily(userId));
  const navigate = useNavigate();

  useEffect(() => {
    if (lookup.data?.conversationId) {
      void navigate({
        to: "/messages/$conversationId",
        params: { conversationId: lookup.data.conversationId },
        replace: true,
      });
    }
  }, [lookup.data, navigate]);

  if (lookup.isPending) return <ThreadSkeleton />;
  if (lookup.isError || !lookup.data.user) {
    return (
      <div className="text-muted-foreground flex h-full min-h-64 flex-col items-center justify-center p-8">
        <p role="alert" className="text-destructive text-sm">
          {m.messages_new_not_found()}
        </p>
      </div>
    );
  }

  const user = lookup.data.user;
  const displayName = user.name || handleOf(user) || m.user_unknown();

  return (
    // Fills the bounded grid cell the /messages layout provides: the header
    // and composer pin as flex children while MessageScroll owns the only
    // scrolling inside the pane.
    <div className="flex h-full flex-col">
      <ThreadHeader
        displayName={displayName}
        handle={handleOf(user)}
        image={user.image}
        userId={user.id}
        onHide={() => {}}
        hidePending={false}
        canHide={false}
      />
      <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-sm">
        {m.messages_new_intro({ name: displayName })}
      </div>
      <Composer recipientId={userId} seedUser={user} />
    </div>
  );
}
