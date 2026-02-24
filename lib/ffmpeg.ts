import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

export type ClipFormat = "landscape" | "vertical" | "square";

interface FfmpegOptions {
  url: string;
  startSec: number;
  duration: number;
  format: ClipFormat;
}

function buildVideoFilter(format: ClipFormat): string {
  switch (format) {
    case "landscape":
      // Scale down to max 1280 wide, keep aspect ratio, ensure even dimensions
      return "scale='min(1280,iw)':-2";
    case "vertical":
      // Scale so height >= 1280 while preserving ratio, then center-crop to 720x1280
      return "scale=-2:1280,crop=720:1280";
    case "square":
      // Scale so the shorter side is at least 720, then center-crop to 720x720
      return "scale='if(gte(iw/ih,1),-2,720)':'if(gte(iw/ih,1),720,-2)',crop=720:720";
  }
}

export function buildFfmpegArgs(opts: FfmpegOptions): { args: string[]; outPath: string } {
  const tmpDir = process.env.TMP_DIR || "/tmp";
  const outPath = path.join(tmpDir, `quickclip_${randomUUID()}.mp4`);

  const vf = buildVideoFilter(opts.format);

  const args = [
    "-hide_banner",
    "-y",
    "-ss",
    opts.startSec.toString(),
    "-i",
    opts.url,
    "-t",
    opts.duration.toString(),
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outPath,
  ];

  return { args, outPath };
}

export function runFfmpeg(args: string[]): Promise<void> {
  const timeoutSec = parseInt(process.env.FFMPEG_TIMEOUT_SECONDS || "120", 10);

  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      // Cap stderr buffer to prevent memory bloat
      if (stderr.length > 50_000) {
        stderr = stderr.slice(-30_000);
      }
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new FfmpegTimeoutError(`FFmpeg timed out after ${timeoutSec}s`));
    }, timeoutSec * 1000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new FfmpegProcessError(`FFmpeg exited with code ${code}`, stderr));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new FfmpegProcessError(`FFmpeg spawn error: ${err.message}`, stderr));
    });
  });
}

export class FfmpegTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FfmpegTimeoutError";
  }
}

export class FfmpegProcessError extends Error {
  public stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = "FfmpegProcessError";
    this.stderr = stderr;
  }
}
