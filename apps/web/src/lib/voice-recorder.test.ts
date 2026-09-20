import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVoiceRecorder,
  formatVoiceDuration,
  type VoiceRecorderEvent,
} from "./voice-recorder";

/**
 * The capture state machine, driven through an injected fake recorder — the
 * same seam the component leaves for tests. jsdom/node have no MediaRecorder,
 * so every test stubs the globals the support probe reads.
 */

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static supported = true;

  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }

  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supported && type.startsWith("audio/");
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    // One chunk per recording, as a real recorder emits.
    this.ondataavailable?.({ data: new Blob(["audio-bytes"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

let now = 0;
const elapsed = vi.fn(() => now);

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.supported = true;
  now = 0;
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createVoiceRecorder", () => {
  it("starts, ticks, and resolves a finished note with the declared duration", async () => {
    const events: VoiceRecorderEvent[] = [];
    const handle = createVoiceRecorder({
      maxDurationMs: 300_000,
      onEvent: (event) => events.push(event),
      now: elapsed,
    });
    await handle.start();
    now = 4200;
    handle.stop();

    expect(events[0]).toEqual({ kind: "recording" });
    const stopped = events.at(-1);
    expect(stopped?.kind).toBe("stopped");
    if (stopped?.kind !== "stopped") return;
    expect(stopped.voice.durationMs).toBe(4200);
    expect(stopped.voice.file.type).toBe("audio/webm");
    expect(stopped.voice.file.size).toBeGreaterThan(0);
    // The microphone was released.
    // (The fake stream's tracks array is empty, so release is trivially safe;
    // the real contract is covered by the permission path below.)
  });

  it("picks the first supported mime type and derives the file extension", async () => {
    const events: VoiceRecorderEvent[] = [];
    const handle = createVoiceRecorder({
      maxDurationMs: 300_000,
      onEvent: (event) => events.push(event),
      now: elapsed,
    });
    await handle.start();
    handle.stop();
    const result = events.at(-1);
    if (result?.kind !== "stopped") throw new Error("Expected a stopped event");
    expect(FakeMediaRecorder.instances[0]?.mimeType).toBe("audio/webm;codecs=opus");
    expect(result.voice.file.name.endsWith(".webm")).toBe(true);
  });

  it("cancel discards the note instead of delivering it", async () => {
    const events: VoiceRecorderEvent[] = [];
    const handle = createVoiceRecorder({
      maxDurationMs: 300_000,
      onEvent: (event) => events.push(event),
      now: elapsed,
    });
    await handle.start();
    handle.cancel();
    expect(events.at(-1)).toEqual({ kind: "cancelled" });
  });

  it.each(["cancel", "stop"] as const)(
    "releases a late microphone grant after %s during permission without recording",
    async (action) => {
      const stop = vi.fn();
      let grant: (stream: { getTracks: () => Array<{ stop: () => void }> }) => void = () => {
        throw new Error("Microphone request has not started");
      };
      const request = new Promise<{ getTracks: () => Array<{ stop: () => void }> }>((resolve) => {
        grant = resolve;
      });
      vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => request } });
      const events: VoiceRecorderEvent[] = [];
      const handle = createVoiceRecorder({
        maxDurationMs: 300_000,
        onEvent: (event) => events.push(event),
      });
      const started = handle.start();
      handle[action]();
      expect(events).toEqual([{ kind: "cancelled" }]);
      grant({ getTracks: () => [{ stop }] });
      await started;
      try {
        expect(stop).toHaveBeenCalledOnce();
        expect(events).toEqual([{ kind: "cancelled" }]);
      } finally {
        handle.cancel();
      }
    },
  );

  it("refuses unsupported browsers before touching the microphone", async () => {
    FakeMediaRecorder.supported = false;
    const events: VoiceRecorderEvent[] = [];
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const handle = createVoiceRecorder({
      maxDurationMs: 300_000,
      onEvent: (event) => events.push(event),
      now: elapsed,
    });
    await handle.start();
    expect(events).toEqual([{ kind: "failed", reason: "unsupported" }]);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("reports a denied microphone as a permission failure", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
      },
    });
    const events: VoiceRecorderEvent[] = [];
    const handle = createVoiceRecorder({
      maxDurationMs: 300_000,
      onEvent: (event) => events.push(event),
      now: elapsed,
    });
    await handle.start();
    expect(events).toEqual([{ kind: "failed", reason: "permission" }]);
  });

  it("auto-stops at the cap so an honest recording never exceeds it", async () => {
    vi.useFakeTimers();
    try {
      const events: VoiceRecorderEvent[] = [];
      const handle = createVoiceRecorder({
        maxDurationMs: 300_000,
        onEvent: (event) => events.push(event),
        now: () => Date.now(),
      });
      await handle.start();
      const recorder = FakeMediaRecorder.instances[0];
      expect(recorder?.state).toBe("recording");
      vi.advanceTimersByTime(300_001);
      expect(recorder?.state).toBe("inactive");
      expect(events.at(-1)?.kind).toBe("stopped");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("formatVoiceDuration", () => {
  it("renders mm:ss", () => {
    expect(formatVoiceDuration(0)).toBe("0:00");
    expect(formatVoiceDuration(4200)).toBe("0:04");
    expect(formatVoiceDuration(61_000)).toBe("1:01");
  });
});
