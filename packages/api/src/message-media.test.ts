import { describe, expect, it } from "vitest";
import { isSafeObjectKey } from "./image.js";
import { acceptVoiceAudio, messageMediaObjectKey, messageVideoMediaPath } from "./message-media.js";

/**
 * Pure validation: the voice sniffers, the key shapes, and the media route's
 * structural acceptance. The image acceptance itself is `post-image.test.ts`'s
 * contract — messages reuse it unchanged and never re-prove it here.
 */

describe("acceptVoiceAudio", () => {
  it("accepts the containers the browser matrix produces, by their leading bytes", () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82]);
    expect(acceptVoiceAudio(webm, "audio/webm")).toMatchObject({ ok: true, type: "audio/webm" });

    const mp4 = new Uint8Array(24);
    for (const [index, character] of [..."....ftypisom"].entries())
      mp4[index] = character.charCodeAt(0);
    expect(acceptVoiceAudio(mp4, "audio/mp4")).toMatchObject({ ok: true, type: "audio/mp4" });

    const ogg = new Uint8Array(Buffer.from("OggS\x00\x02rest-of-page"));
    expect(acceptVoiceAudio(ogg, "audio/ogg")).toMatchObject({ ok: true, type: "audio/ogg" });

    const wav = new Uint8Array(Buffer.from("RIFF____WAVEfmt "));
    expect(acceptVoiceAudio(wav, "audio/wav")).toMatchObject({ ok: true, type: "audio/wav" });

    const mp3 = new Uint8Array(Buffer.from("ID3\x04rest"));
    expect(acceptVoiceAudio(mp3, "audio/mpeg")).toMatchObject({ ok: true, type: "audio/mpeg" });

    // A bare ADTS sync word is AAC; the wider frame sync is MPEG audio.
    expect(acceptVoiceAudio(new Uint8Array([0xff, 0xf1, 0x50, 0x80]), "audio/aac")).toMatchObject({
      ok: true,
      type: "audio/aac",
    });
    expect(acceptVoiceAudio(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), "audio/mpeg")).toMatchObject({
      ok: true,
      type: "audio/mpeg",
    });
  });

  it("refuses non-audio bytes whatever they are declared as", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(acceptVoiceAudio(png, "audio/webm")).toMatchObject({ ok: false, reason: "type" });
    expect(acceptVoiceAudio(new Uint8Array([1, 2, 3]), "audio/webm")).toMatchObject({
      ok: false,
      reason: "type",
    });
    // An empty body is a refusal before any sniffing.
    expect(acceptVoiceAudio(new Uint8Array(0), "audio/webm")).toMatchObject({
      ok: false,
      reason: "size",
    });
  });

  it("bounds the accepted size and the declared-type allowlist before sniffing", () => {
    const oversized = new Uint8Array(10_000_001);
    expect(acceptVoiceAudio(oversized, "audio/webm")).toMatchObject({ ok: false, reason: "size" });
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
    expect(acceptVoiceAudio(webm, "text/plain")).toMatchObject({ ok: false, reason: "type" });
  });
});

describe("attachment key shapes", () => {
  it("mints message-scoped object keys and manifest paths the media route accepts", () => {
    const [messageId, attachmentId] = [crypto.randomUUID(), crypto.randomUUID()];
    expect(messageMediaObjectKey(messageId, attachmentId, "image/png")).toBe(
      `messages/${messageId}/${attachmentId}.png`,
    );
    expect(messageMediaObjectKey(messageId, attachmentId, "audio/webm")).toBe(
      `messages/${messageId}/${attachmentId}.webm`,
    );
    expect(messageMediaObjectKey(messageId, attachmentId, "audio/mp4")).toBe(
      `messages/${messageId}/${attachmentId}.m4a`,
    );
    expect(isSafeObjectKey(messageMediaObjectKey(messageId, attachmentId, "image/png"))).toBe(true);
    expect(isSafeObjectKey(messageMediaObjectKey(messageId, attachmentId, "audio/ogg"))).toBe(true);

    const videoId = crypto.randomUUID();
    expect(messageVideoMediaPath(videoId)).toBe(`/media/videos/${videoId}/master.m3u8`);

    // The structural guard keeps refusing traversal and foreign shapes.
    expect(isSafeObjectKey(`messages/${messageId}/../../avatar.png`)).toBe(false);
    expect(isSafeObjectKey(`messages/${messageId}/${attachmentId}.exe`)).toBe(false);
  });
});
