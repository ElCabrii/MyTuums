export interface VideoPreview {
  start: number;
  end: number;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The worker's preview VTT is a bounded index into authorized image sprites. */
export function parseVideoPreviews(text: string, base: string): VideoPreview[] {
  const previews: VideoPreview[] = [];
  if (text.length > 100_000 || !text.startsWith("WEBVTT")) return previews;
  const seconds = (timestamp: string) =>
    timestamp.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  for (const block of text.replaceAll("\r", "").split(/\n\n+/)) {
    const match =
      /(?:^|\n)(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})\n([^\s]+)#xywh=(\d+),(\d+),(\d+),(\d+)/.exec(
        block,
      );
    if (!match) continue;
    const [, start, end, path, x, y, width, height] = match;
    if (!start || !end || !path || !x || !y || !width || !height) continue;
    const url = new URL(path, base);
    if (url.origin !== new URL(base).origin || !url.pathname.startsWith("/media/videos/")) continue;
    previews.push({
      start: seconds(start),
      end: seconds(end),
      url: url.href,
      x: Number(x),
      y: Number(y),
      width: Number(width),
      height: Number(height),
    });
  }
  return previews;
}

export function videoTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
