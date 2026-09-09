import { spawn } from "node:child_process";

interface MediaProcessOptions {
  cwd: string;
  signal: AbortSignal;
  maxOutputBytes?: number;
}

export class MediaProcessError extends Error {
  constructor(readonly reason: "start" | "exit" | "output_limit") {
    // FFmpeg diagnostics contain filenames, tags and sometimes caption text.
    // Never propagate them into queue failure archives or application logs.
    super(`Media process failed: ${reason}.`);
    this.name = "MediaProcessError";
  }
}

/** Resolves only after the child exits, including on cancellation. */
export function runMediaProcess(
  executable: "ffmpeg" | "ffprobe",
  args: readonly string[],
  { cwd, signal, maxOutputBytes = 1024 * 1024 }: MediaProcessOptions,
): Promise<{ stdout: string; stderr: string }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, LANG: "C", TMPDIR: cwd },
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failure: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = () => {
      if (killTimer) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      killTimer.unref();
    };
    const abort = () => {
      failure = new Error("Media processing was cancelled.", { cause: signal.reason });
      terminate();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        failure ??= new MediaProcessError("output_limit");
        terminate();
      } else {
        stdout += chunk;
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-64 * 1024);
    });
    child.on("error", () => {
      failure ??= new MediaProcessError("start");
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      clearTimeout(killTimer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new MediaProcessError("exit"));
      else resolve({ stdout, stderr });
    });
  });
}
