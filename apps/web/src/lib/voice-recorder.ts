/**
 * The voice-note capture state machine (issue #408): microphone → MediaRecorder
 * → one finished blob. Deliberately framework-free and test-injectable — the
 * recorder constructor is a parameter, so unit tests drive a fake and the
 * component only mirrors events into React state.
 *
 * The duration is the caller's elapsed-time measurement, not the container's:
 * browsers do not reliably write duration into MediaRecorder WebM headers, and
 * the server stores it as a declared value bounded by the byte cap — the same
 * honesty a video upload's accepted `byteSize` has. Recording auto-stops at
 * the shared cap, so an honest recording never exceeds it.
 */

export interface RecordedVoice {
  file: File;
  /** Elapsed-wall-clock recording length, the declared durationMs. */
  durationMs: number;
}

export type VoiceRecorderEvent =
  | { kind: "recording" }
  | { kind: "tick"; elapsedMs: number }
  | { kind: "stopped"; voice: RecordedVoice }
  | { kind: "cancelled" }
  | { kind: "failed"; reason: "unsupported" | "permission" | "error" };

export interface VoiceRecorderHandle {
  /** Requests the microphone and begins recording; one start per handle. */
  start(): Promise<void>;
  /** Finishes the recording; `stopped` (or `failed`) follows. */
  stop(): void;
  /** Discards the recording; `cancelled` follows. */
  cancel(): void;
}

/** The mime candidates, best compression first; the first supported wins. */
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;

/** Strip the codecs parameter for the declared content type. */
function declaredType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim() ?? "audio/webm";
}

function extensionFor(type: string): string {
  switch (type) {
    case "audio/mp4":
      return "m4a";
    case "audio/ogg":
      return "ogg";
    case "audio/mpeg":
      return "mp3";
    default:
      return "webm";
  }
}

export function voiceRecordingSupported(navigatorLike: Navigator = globalThis.navigator) {
  return (
    Boolean(navigatorLike?.mediaDevices && "getUserMedia" in navigatorLike.mediaDevices) &&
    Boolean(globalThis.MediaRecorder) &&
    MIME_CANDIDATES.some((type) => MediaRecorder.isTypeSupported(type))
  );
}

export function createVoiceRecorder(options: {
  maxDurationMs: number;
  onEvent: (event: VoiceRecorderEvent) => void;
  /** Injection seam for tests; production uses the real MediaRecorder. */
  createRecorder?: (stream: MediaStream, mimeType: string) => MediaRecorder;
  now?: () => number;
}): VoiceRecorderHandle {
  const { maxDurationMs, onEvent } = options;
  const now = options.now ?? (() => Date.now());
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let startedAt = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  let started = false;
  let cancelled = false;
  let endedAt: number | null = null;

  const cleanup = () => {
    if (ticker) clearInterval(ticker);
    if (stopTimer) clearTimeout(stopTimer);
    ticker = stopTimer = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  };

  return {
    async start() {
      if (started || cancelled) return;
      started = true;
      if (!voiceRecordingSupported()) {
        onEvent({ kind: "failed", reason: "unsupported" });
        return;
      }
      const mimeType = MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) {
        onEvent({ kind: "failed", reason: "unsupported" });
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        if (!cancelled) onEvent({ kind: "failed", reason: "permission" });
        return;
      }
      if (cancelled) {
        cleanup();
        return;
      }
      try {
        recorder = (
          options.createRecorder ??
          ((mediaStream, type) => new MediaRecorder(mediaStream, { mimeType: type }))
        )(stream, mimeType);
      } catch {
        cleanup();
        onEvent({ kind: "failed", reason: "error" });
        return;
      }
      finished = false;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const elapsedMs = Math.max(1, Math.min(maxDurationMs, (endedAt ?? now()) - startedAt));
        const type = declaredType(recorder?.mimeType ?? mimeType);
        const blob = new Blob(chunks, { type });
        cleanup();
        const voice: RecordedVoice = {
          file: new File([blob], `voice-note.${extensionFor(type)}`, { type }),
          durationMs: elapsedMs,
        };
        recorder = null;
        if (finished && !cancelled) onEvent({ kind: "stopped", voice });
      };
      startedAt = now();
      recorder.onerror = () => {
        cancelled = true;
        cleanup();
        onEvent({ kind: "failed", reason: "error" });
      };
      try {
        recorder.start();
      } catch {
        cleanup();
        onEvent({ kind: "failed", reason: "error" });
        return;
      }
      onEvent({ kind: "recording" });
      ticker = setInterval(() => {
        onEvent({ kind: "tick", elapsedMs: now() - startedAt });
      }, 200);
      // The cap auto-stops: an honest recording never exceeds the server's
      // declared-duration bound, and the cap's stop DELIVERS the note (it is
      // a recording that ran its full length, not a discarded one).
      stopTimer = setTimeout(() => {
        if (recorder && recorder.state === "recording") {
          finished = true;
          endedAt = now();
          recorder.stop();
        }
      }, maxDurationMs);
    },
    stop() {
      finished = true;
      endedAt = now();
      if (recorder?.state === "recording") recorder.stop();
      else if (!recorder) cleanup();
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      finished = false;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      cleanup();
      onEvent({ kind: "cancelled" });
    },
  };
}

/** mm:ss formatting shared by the recorder's ticker and the voice player. */
export function formatVoiceDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
