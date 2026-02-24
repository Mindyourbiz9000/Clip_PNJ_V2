import { spawn } from "node:child_process";

/**
 * Matches Twitch VOD URLs like:
 *   https://www.twitch.tv/videos/2704979823
 *   https://twitch.tv/videos/2704979823
 */
const TWITCH_VOD_RE = /^https?:\/\/(?:www\.)?twitch\.tv\/videos\/(\d+)/;

export function isTwitchUrl(url: string): boolean {
  return TWITCH_VOD_RE.test(url);
}

export function isSupportedPlatformUrl(url: string): boolean {
  return isTwitchUrl(url);
}

/**
 * Uses yt-dlp to extract the direct stream URL from a platform URL.
 * Returns the best quality URL that FFmpeg can consume directly.
 */
export async function resolveStreamUrl(url: string): Promise<string> {
  const timeoutMs = 30_000;

  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", [
      "--get-url",          // output just the direct URL
      "--no-warnings",
      "--no-playlist",
      "-f", "best",         // best single format
      url,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 10_000) {
        stderr = stderr.slice(-5_000);
      }
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new UrlResolveError("URL resolution timed out"));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const resolvedUrl = stdout.trim().split("\n")[0];
        if (!resolvedUrl) {
          reject(new UrlResolveError("yt-dlp returned empty output"));
          return;
        }
        resolve(resolvedUrl);
      } else {
        reject(
          new UrlResolveError(
            `Failed to resolve video URL. The video may be unavailable or require authentication.`
          )
        );
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new UrlResolveError(
            "yt-dlp is not installed on this server. Platform URL resolution is unavailable."
          )
        );
      } else {
        reject(new UrlResolveError(`Failed to launch yt-dlp: ${err.message}`));
      }
    });
  });
}

export class UrlResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlResolveError";
  }
}
