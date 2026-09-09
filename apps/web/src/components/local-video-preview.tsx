import { useEffect, useId, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { activeVideoAtom, requestVideoPlaybackAtom } from "@/atoms/video-playback";
import { useVideoVisibility } from "@/hooks/use-video-visibility";
import { m } from "@/paraglide/messages.js";

export function LocalVideoPreview({ file }: { file: File }) {
  const id = useId();
  const videoRef = useRef<HTMLVideoElement>(null);
  const active = useAtomValue(activeVideoAtom) === id;
  const requestPlayback = useSetAtom(requestVideoPlaybackAtom);
  const [unavailable, setUnavailable] = useState(false);
  useVideoVisibility({ ref: videoRef, id, autoplay: false });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const url = URL.createObjectURL(file);
    video.src = url;
    return () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    };
  }, [file]);

  useEffect(() => {
    if (!active) videoRef.current?.pause();
  }, [active]);

  return (
    <div>
      <video
        ref={videoRef}
        controls
        playsInline
        preload="metadata"
        hidden={unavailable}
        className="max-h-80 w-full rounded-lg bg-black object-contain"
        aria-label={m.video_preview_label()}
        onLoadedMetadata={() => setUnavailable(false)}
        onPlay={() => requestPlayback({ id, play: true })}
        onPause={() => {
          if (active) requestPlayback({ id, play: false });
        }}
        onError={() => {
          setUnavailable(true);
          if (active) requestPlayback({ id, play: false, releaseSource: true });
        }}
      />
      {unavailable && (
        <p role="status" className="text-muted-foreground text-sm">
          {m.video_preview_unavailable()}
        </p>
      )}
    </div>
  );
}
