import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { useVideoVisibility } from "@/hooks/use-video-visibility";
import { useAtomValue, useSetAtom } from "jotai";
import { Captions, Maximize, Pause, PictureInPicture2, Play, Volume2, VolumeX } from "lucide-react";
import {
  activeVideoAtom,
  requestedVideoAtom,
  requestVideoPlaybackAtom,
  videoSourceOwnerAtom,
} from "@/atoms/video-playback";
import type { Post } from "@/lib/orpc";
import { parseVideoPreviews, videoTime, type VideoPreview } from "@/lib/video-previews";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { m } from "@/paraglide/messages.js";

type VideoAttachment = Post["attachments"][number];

/** TextTrack.mode is browser-owned state and has no declarative video property. */
function showCaptions(video: HTMLVideoElement, visible: boolean): void {
  for (const track of video.textTracks) track.mode = visible ? "showing" : "disabled";
}

export function VideoPlayer({ attachment }: { attachment: VideoAttachment }) {
  const metadata = attachment.video;
  const id = useId();
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef(0);
  const active = useAtomValue(activeVideoAtom) === id;
  const ownsSource = useAtomValue(videoSourceOwnerAtom) === id;
  const manual = useAtomValue(requestedVideoAtom) === id;
  const requestPlayback = useSetAtom(requestVideoPlaybackAtom);
  const [fullscreen, setFullscreen] = useState(false);
  useVideoVisibility({ ref: containerRef, id });
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(true);
  const [quality, setQuality] = useState(-1);
  const [speed, setSpeed] = useState(1);
  const [captions, setCaptions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [previews, setPreviews] = useState<VideoPreview[]>([]);
  const [previewsRequested, setPreviewsRequested] = useState(false);
  const duration = metadata?.duration ?? 0;
  const rendition = metadata?.renditions[quality];
  const source = rendition
    ? new URL(`${rendition.name}.m3u8`, new URL(attachment.url, window.location.origin)).href
    : attachment.url;

  const onSourceReady = useEffectEvent(() => {
    const video = videoRef.current;
    if (!video) return Promise.resolve();
    video.currentTime = positionRef.current;
    return active ? video.play() : Promise.resolve();
  });

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !ownsSource) return;
    let disposed = false;
    let hls: import("hls.js").default | undefined;
    const start = () => {
      if (disposed) return;
      void onSourceReady().catch((error: DOMException) => {
        // A pause or source change can abort an outstanding play() request.
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!disposed) requestPlayback({ id, play: false });
      });
    };
    setError(null);
    void import("hls.js")
      .then(({ default: HlsPlayer }) => {
        if (disposed) return;
        if (HlsPlayer.isSupported()) {
          hls = new HlsPlayer({
            maxBufferLength: 12,
            maxMaxBufferLength: 20,
            backBufferLength: 8,
            startPosition: positionRef.current,
            capLevelToPlayerSize: quality === -1,
          });
          hls.on(HlsPlayer.Events.MEDIA_ATTACHED, () => hls?.loadSource(source));
          hls.on(HlsPlayer.Events.MANIFEST_PARSED, start);
          hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
            if (data.fatal) {
              setError(m.video_playback_error());
              requestPlayback({ id, play: false, releaseSource: true });
            }
          });
          hls.attachMedia(video);
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.addEventListener("loadedmetadata", start, { once: true });
          video.src = source;
          video.load();
        } else {
          setError(m.video_playback_unsupported());
          requestPlayback({ id, play: false, releaseSource: true });
        }
      })
      .catch(() => {
        if (!disposed) {
          setError(m.video_playback_error());
          requestPlayback({ id, play: false, releaseSource: true });
        }
      });
    return () => {
      disposed = true;
      if (video.readyState) positionRef.current = video.currentTime;
      video.pause();
      video.removeEventListener("loadedmetadata", start);
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [ownsSource, id, source, quality, requestPlayback]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let disposed = false;
    if (!active) video.pause();
    else if (video.readyState)
      void video.play().catch((error: DOMException) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!disposed) requestPlayback({ id, play: false });
      });
    return () => {
      disposed = true;
    };
  }, [active, id, requestPlayback]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = muted || !manual;
    video.playbackRate = speed;
    showCaptions(video, captions);
  }, [volume, muted, manual, speed, captions, active, quality]);

  useEffect(() => {
    if (!previewsRequested || !metadata?.previewUrl) return;
    const controller = new AbortController();
    void fetch(metadata.previewUrl, { signal: controller.signal })
      .then(async (response) => {
        if (response.ok)
          setPreviews(parseVideoPreviews(await response.text(), window.location.origin));
      })
      .catch(() => {
        /* A preview failure must not interrupt playable video. */
      });
    return () => controller.abort();
  }, [previewsRequested, metadata?.previewUrl]);

  if (!metadata) return null;
  const preview =
    hoverTime === null
      ? undefined
      : previews.find((cue) => cue.start <= hoverTime && cue.end > hoverTime);
  const seek = (value: number | readonly number[]) => {
    const next = [value].flat()[0];
    if (next === undefined) return;
    positionRef.current = next;
    setPosition(next);
    if (videoRef.current?.readyState) videoRef.current.currentTime = next;
  };
  const togglePlayback = () => {
    if (position >= duration) positionRef.current = 0;
    requestPlayback({ id, play: !active });
  };
  return (
    <div
      ref={containerRef}
      className="group/video border-border mb-3 overflow-hidden rounded-lg border [&:fullscreen]:m-0 [&:fullscreen]:flex [&:fullscreen]:flex-col [&:fullscreen]:rounded-none [&:fullscreen]:border-0 [&:fullscreen]:bg-black [&:fullscreen]:text-white [&:fullscreen]:scheme-dark"
      role="group"
      aria-label={m.video_player_label()}
      onClick={(event) => event.stopPropagation()}
    >
      <video
        ref={videoRef}
        className="block max-h-[32rem] w-full bg-black object-contain group-[:fullscreen]/video:max-h-none group-[:fullscreen]/video:min-h-0 group-[:fullscreen]/video:flex-1"
        width={attachment.width}
        height={attachment.height}
        poster={metadata.posterUrl}
        preload="none"
        playsInline
        muted={muted || !manual}
        tabIndex={0}
        aria-label={m.video_player_label()}
        aria-keyshortcuts="Space"
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          togglePlayback();
        }}
        onKeyDown={(event) => {
          if (event.key !== " " || event.altKey || event.ctrlKey || event.metaKey) return;
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) togglePlayback();
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEmptied={() => setPlaying(false)}
        onTimeUpdate={(event) => {
          if (event.currentTarget.readyState) {
            positionRef.current = event.currentTarget.currentTime;
            setPosition(event.currentTarget.currentTime);
          }
        }}
        onEnded={() => {
          requestPlayback({ id, play: false });
          positionRef.current = 0;
        }}
        onError={() => {
          if (active) setError(m.video_playback_error());
        }}
      >
        {metadata.captionUrl && (
          <track
            kind="subtitles"
            src={metadata.captionUrl}
            srcLang={metadata.captionLanguage ?? "en"}
            label={m.video_captions()}
            onLoad={(event) => {
              event.currentTarget.track.mode = captions ? "showing" : "disabled";
            }}
          />
        )}
      </video>
      <div className="shrink-0 space-y-2 p-3">
        <div
          className="relative pt-1"
          onPointerMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setHoverTime(
              Math.max(0, Math.min(duration, ((event.clientX - box.left) / box.width) * duration)),
            );
            setPreviewsRequested(true);
          }}
          onPointerLeave={() => setHoverTime(null)}
          onPointerUp={(event) => {
            if (event.pointerType !== "mouse") setHoverTime(null);
          }}
        >
          {hoverTime !== null && (
            <div
              className="bg-popover text-popover-foreground pointer-events-none absolute bottom-6 z-10 -translate-x-1/2 overflow-hidden rounded-md border shadow"
              style={{ left: `${Math.max(15, Math.min(85, (hoverTime / duration) * 100))}%` }}
            >
              {preview && (
                <div
                  style={{
                    width: preview.width,
                    height: preview.height,
                    backgroundImage: `url(${JSON.stringify(preview.url)})`,
                    backgroundPosition: `-${preview.x}px -${preview.y}px`,
                  }}
                />
              )}
              <p className="px-2 py-1 text-center text-xs tabular-nums">{videoTime(hoverTime)}</p>
            </div>
          )}
          <span id={`${id}-seek`} className="sr-only">
            {m.video_seek()}
          </span>
          <Slider
            aria-labelledby={`${id}-seek`}
            min={0}
            max={duration}
            step={0.1}
            value={[position]}
            onValueChange={seek}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={active ? m.video_pause() : m.video_play()}
            onClick={togglePlayback}
          >
            {active ? <Pause /> : <Play />}
          </Button>
          <span className="mr-auto text-xs tabular-nums">
            {videoTime(position)} / {videoTime(duration)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={muted || !manual ? m.video_unmute() : m.video_mute()}
            onClick={() => {
              setMuted(!(muted || !manual));
              requestPlayback({ id, play: true });
            }}
          >
            {muted || !manual ? <VolumeX /> : <Volume2 />}
          </Button>
          <div className="w-16">
            <span id={`${id}-volume`} className="sr-only">
              {m.video_volume()}
            </span>
            <Slider
              aria-labelledby={`${id}-volume`}
              min={0}
              max={1}
              step={0.05}
              value={[muted || !manual ? 0 : volume]}
              onValueChange={(value) => {
                const next = [value].flat()[0];
                if (next !== undefined) {
                  setVolume(next);
                  setMuted(next === 0);
                  requestPlayback({ id, play: true });
                }
              }}
            />
          </div>
          {metadata.captionUrl && (
            <Button
              type="button"
              variant={captions ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={m.video_captions()}
              aria-pressed={captions}
              onClick={() => setCaptions(!captions)}
            >
              <Captions />
            </Button>
          )}
          <Select
            value={quality}
            items={[
              { value: -1, label: m.video_quality_auto() },
              ...metadata.renditions.map((level, index) => ({
                value: index,
                label: `${Math.min(level.width, level.height)}p${level.frameRate > 30 ? "60" : ""}`,
              })),
            ]}
            onValueChange={(value) => {
              if (value !== null) setQuality(value);
            }}
          >
            <SelectTrigger size="sm" aria-label={m.video_quality()}>
              <SelectValue />
            </SelectTrigger>
            {/* Nested portals inherit this container, keeping menus inside fullscreen. */}
            <SelectPrimitive.Portal container={fullscreen ? containerRef : undefined}>
              <SelectContent>
                <SelectItem value={-1}>{m.video_quality_auto()}</SelectItem>
                {metadata.renditions.map((level, index) => (
                  <SelectItem
                    key={level.name}
                    value={index}
                  >{`${Math.min(level.width, level.height)}p${level.frameRate > 30 ? "60" : ""}`}</SelectItem>
                ))}
              </SelectContent>
            </SelectPrimitive.Portal>
          </Select>
          <Select
            value={speed}
            items={[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => ({ value, label: `${value}×` }))}
            onValueChange={(value) => {
              if (value !== null) setSpeed(value);
            }}
          >
            <SelectTrigger size="sm" aria-label={m.video_speed()}>
              <SelectValue />
            </SelectTrigger>
            <SelectPrimitive.Portal container={fullscreen ? containerRef : undefined}>
              <SelectContent>
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}×
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectPrimitive.Portal>
          </Select>
          {document.pictureInPictureEnabled && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={m.video_pip()}
              disabled={!playing}
              onClick={() => {
                const video = videoRef.current;
                if (video)
                  void (
                    document.pictureInPictureElement
                      ? document.exitPictureInPicture()
                      : video.requestPictureInPicture()
                  ).catch(() => setError(m.video_action_unavailable()));
              }}
            >
              <PictureInPicture2 />
            </Button>
          )}
          {document.fullscreenEnabled && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={m.video_fullscreen()}
              onClick={() => {
                const container = containerRef.current;
                if (container)
                  void (
                    document.fullscreenElement
                      ? document.exitFullscreen()
                      : container.requestFullscreen()
                  ).catch(() => setError(m.video_action_unavailable()));
              }}
            >
              <Maximize />
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
