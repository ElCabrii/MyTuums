import { useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import { ImageViewer } from "@/components/image-viewer";
import { VideoPlayer } from "@/components/video-player";
import { formatVoiceDuration } from "@/lib/voice-recorder";
import type { MessageAttachment } from "@/lib/orpc";
import { m } from "@/paraglide/messages.js";

/** Video states where the bubble waits on Stream instead of playing. */
export const TERMINAL_VIDEO_STATES = new Set(["published", "failed", "cancelled", "deleted"]);

/**
 * The media half of one message bubble (issue #408): the image grid through
 * the shared full-size viewer, voice notes through a self-contained player,
 * and Stream videos in one of two ways — the ordinary player once published,
 * a bounded waiting/failed chip before that. The server redacts attachments
 * of tombstoned messages, so this component never renders one.
 */
export function MessageAttachments({
  attachments,
  mine,
}: {
  attachments: MessageAttachment[];
  mine: boolean;
}) {
  if (attachments.length === 0) return null;
  const images = attachments.filter((attachment) => attachment.kind === "image");
  return (
    <div className="space-y-1.5">
      {images.length > 0 && (
        <div className={images.length > 1 ? "grid max-w-64 grid-cols-2 gap-1" : "max-w-64"}>
          {images.map((attachment) => (
            <ImageViewer
              key={attachment.id}
              src={attachment.url}
              alt={m.messages_media_image_label({ name: String(attachment.position + 1) })}
              title={m.messages_media_open()}
              triggerClassName="w-full"
            >
              <img
                src={attachment.url}
                alt={m.messages_media_image_label({ name: String(attachment.position + 1) })}
                loading="lazy"
                className="aspect-square w-full rounded-xl object-cover"
              />
            </ImageViewer>
          ))}
        </div>
      )}
      {attachments
        .filter((attachment) => attachment.kind === "voice")
        .map((attachment) => (
          <VoiceBubble
            key={attachment.id}
            url={attachment.url}
            durationMs={attachment.durationMs ?? 0}
            mine={mine}
          />
        ))}
      {attachments
        .filter((attachment) => attachment.kind === "video")
        .map((attachment) => {
          const playback = attachment.video;
          return playback && playback.state === "published" ? (
            // The published object carries the post player's exact metadata
            // shape (the projection mirrors it), so one player serves both.
            // Width/height are layout inputs only here; the player derives
            // real dimensions from the HLS manifest.
            <div key={attachment.id} className="w-64 max-w-full overflow-hidden rounded-xl">
              <VideoPlayer
                attachment={{
                  id: attachment.id,
                  url: attachment.url,
                  position: attachment.position,
                  contentType: attachment.contentType,
                  byteSize: attachment.byteSize,
                  width: attachment.width ?? 0,
                  height: attachment.height ?? 0,
                  video: playback,
                }}
              />
            </div>
          ) : (
            <div
              key={attachment.id}
              className="text-muted-foreground flex w-64 max-w-full items-center gap-2 rounded-xl border border-dashed p-3 text-xs"
              role={playback && !TERMINAL_VIDEO_STATES.has(playback.state) ? "status" : undefined}
            >
              {playback && !TERMINAL_VIDEO_STATES.has(playback.state) ? (
                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
              ) : null}
              {playback && !TERMINAL_VIDEO_STATES.has(playback.state)
                ? m.messages_video_processing()
                : m.messages_video_failed()}
            </div>
          );
        })}
    </div>
  );
}

/**
 * One voice note's inline player. The declared recording length is the
 * duration authority — browser-recorded WebM headers frequently omit duration,
 * and the server stores the same declared measurement — while the element's
 * currentTime drives the seek bar and the replay position.
 */
export function VoiceBubble({
  url,
  file,
  durationMs,
  mine,
}: {
  url?: string;
  file?: File;
  durationMs: number;
  mine: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const source = file ? URL.createObjectURL(file) : url;
    if (source) audio.src = source;
    return () => {
      audio.pause();
      audio.removeAttribute("src");
      if (file && source) URL.revokeObjectURL(source);
    };
  }, [url, file]);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const total = durationMs > 0 ? durationMs : positionMs;
  const progress = total > 0 ? Math.min(100, (positionMs / total) * 100) : 0;

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      void audio.play().catch(() => setPlaying(false));
    }
  };

  return (
    <div className="flex w-56 max-w-full items-center gap-2 py-0.5">
      <button
        type="button"
        aria-label={playing ? m.messages_voice_pause() : m.messages_voice_play()}
        onClick={toggle}
        className={`flex size-8 shrink-0 items-center justify-center rounded-full ${
          mine
            ? "bg-primary-foreground/20 text-primary-foreground"
            : "bg-background text-foreground"
        }`}
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </button>
      <div
        className={`h-1.5 min-w-0 flex-1 overflow-hidden rounded-full ${
          mine ? "bg-primary-foreground/25" : "bg-muted-foreground/25"
        }`}
        role="progressbar"
        aria-label={m.messages_preview_voice()}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      >
        <div
          className={`h-full rounded-full ${mine ? "bg-primary-foreground" : "bg-primary"}`}
          style={{ width: `${progress}%` }}
        />
      </div>
      <span
        className={`shrink-0 text-[10px] tabular-nums ${
          mine ? "text-primary-foreground/70" : "text-muted-foreground"
        }`}
      >
        {formatVoiceDuration(positionMs > 0 && playing ? positionMs : total)}
      </span>
      <audio
        ref={audioRef}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPositionMs(0);
        }}
        onTimeUpdate={(event) => setPositionMs(event.currentTarget.currentTime * 1000)}
        aria-hidden="true"
      />
    </div>
  );
}
