import { VIDEO_CAPTION_MAX_BYTES, VIDEO_MAX_DURATION_SECONDS } from "./constants.js";

function timestamp(value: string): number {
  const match = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(value);
  if (!match) return NaN;
  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1000
  );
}

/** Accept WebVTT cues; discard author CSS/regions and keep player-owned styling. */
export function normalizeVideoCaptions(input: string): string {
  if (Buffer.byteLength(input, "utf8") > VIDEO_CAPTION_MAX_BYTES || input.includes("\0"))
    throw new Error("Invalid captions.");
  const blocks = input
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n[\t ]*\n+/);
  const header = blocks.shift();
  if (!header || !/^WEBVTT(?:[\t ][^\n]*)?$/.test(header)) throw new Error("Invalid captions.");
  const cues: string[] = [];
  let previousStart = -1;
  for (const block of blocks) {
    if (/^(?:NOTE(?:[ \t\n]|$)|STYLE(?:\n|$)|REGION(?:\n|$))/.test(block)) continue;
    const lines = block.split("\n");
    if (!lines[0]?.includes("-->")) lines.shift(); // Optional cue identifier.
    const timing = lines.shift()?.match(/^(\S+)[\t ]+-->[\t ]+(\S+)(?:[\t ]+.*)?$/);
    if (!timing?.[1] || !timing[2]) throw new Error("Invalid captions.");
    const start = timestamp(timing[1]);
    const end = timestamp(timing[2]);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < previousStart ||
      end <= start ||
      end > VIDEO_MAX_DURATION_SECONDS
    )
      throw new Error("Invalid captions.");
    previousStart = start;
    const text = lines.join("\n").trim();
    if (!text || text.includes("-->")) throw new Error("Invalid captions.");
    cues.push(`${timing[1]} --> ${timing[2]}\n${text}`);
  }
  if (!cues.length) throw new Error("Invalid captions.");
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}
