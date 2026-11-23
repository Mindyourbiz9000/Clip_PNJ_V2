import { NextRequest } from "next/server";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { isTwitchUrl, resolveStreamUrl, UrlResolveError } from "@/lib/resolveUrl";
import { extractVideoId } from "@/lib/twitchChat";
import { Semaphore } from "@/lib/semaphore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FRAMES = 10;
const MAX_SPAN_SEC = 60;
/** Small video format: enough for thumbnails, fast to decode. */
const SMALL_FORMAT = "best[height<=480]/worst";

/** One screenshot job at a time (the server is small). */
const framesSemaphore = new Semaphore(1);

/** yt-dlp is slow (~3-5 s): remember the stream URL of each VOD for 30 min. */
const streamCache = new Map<string, { url: string; at: number }>();
const CACHE_MS = 30 * 60 * 1000;

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function getStreamUrl(vodUrl: string, videoId: string): Promise<string> {
  const hit = streamCache.get(videoId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.url;
  const url = await resolveStreamUrl(vodUrl, SMALL_FORMAT);
  streamCache.set(videoId, { url, at: Date.now() });
  return url;
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Screenshot extraction timed out"));
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}: ${stderr.split("\n").slice(-3).join(" ")}`));
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * GET /api/frames?url=<twitch vod>&start=<sec>&end=<sec>
 * Returns up to 10 small JPEG screenshots (base64) spread over the range.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const url = searchParams.get("url") ?? "";
  const start = Number(searchParams.get("start"));
  const end = Number(searchParams.get("end"));

  if (!isTwitchUrl(url)) return jsonError("A valid Twitch VOD URL is required", 400);
  const videoId = extractVideoId(url);
  if (!videoId) return jsonError("Could not extract video ID from URL", 400);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    return jsonError("Invalid start / end", 400);
  }
  const span = Math.min(end - start, MAX_SPAN_SEC);
  const step = span / MAX_FRAMES;

  await framesSemaphore.acquire();
  const dir = await mkdtemp(path.join(process.env.TMP_DIR || "/tmp", "frames-"));
  try {
    const streamUrl = await getStreamUrl(url, videoId);
    // One pass: seek to start, take one frame every `step` seconds, small JPEGs
    await runFfmpeg(
      [
        "-hide_banner", "-loglevel", "error",
        "-ss", start.toString(),
        "-i", streamUrl,
        "-t", span.toString(),
        "-vf", `fps=1/${step},scale=480:-2`,
        "-frames:v", MAX_FRAMES.toString(),
        "-q:v", "5",
        path.join(dir, "f_%02d.jpg"),
      ],
      60_000
    );

    const files = (await readdir(dir)).filter((f) => f.endsWith(".jpg")).sort();
    const frames = await Promise.all(
      files.map(async (f, i) => ({
        sec: Math.round(start + i * step),
        data: `data:image/jpeg;base64,${(await readFile(path.join(dir, f))).toString("base64")}`,
      }))
    );
    return new Response(JSON.stringify({ frames }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=600" },
    });
  } catch (err) {
    streamCache.delete(videoId); // the signed stream URL may have expired
    const message =
      err instanceof UrlResolveError ? err.message : err instanceof Error ? err.message : String(err);
    console.error("Frames error:", message);
    return jsonError(`Could not take screenshots: ${message}`, 502);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    framesSemaphore.release();
  }
}
