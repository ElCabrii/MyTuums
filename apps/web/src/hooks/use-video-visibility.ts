import { useEffect, type RefObject } from "react";
import { useSetAtom } from "jotai";
import { updateVideoVisibilityAtom } from "@/atoms/video-playback";

/** Feed players and local previews share the same viewport and tab visibility rules. */
export function useVideoVisibility({
  ref,
  id,
  autoplay = true,
}: {
  ref: RefObject<HTMLElement | null>;
  id: string;
  autoplay?: boolean;
}): void {
  const visibility = useSetAtom(updateVideoVisibilityAtom);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let ratio = 0;
    const update = () => visibility({ id, ratio: document.hidden ? 0 : ratio, autoplay });
    const observer = new IntersectionObserver(
      ([entry]) => {
        ratio = entry?.intersectionRatio ?? 0;
        update();
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      visibility({ id, remove: true });
    };
  }, [autoplay, id, ref, visibility]);
}
