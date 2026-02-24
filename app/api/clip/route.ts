import { NextRequest } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import { validateUrl } from "@/lib/validateUrl";
import { validateTimes } from "@/lib/time";
import { clipSemaphore } from "@/lib/semaphore";
import { buildFfmpegArgs, runFfmpeg, FfmpegTimeoutError, FfmpegProcessError, type ClipFormat } from "@/lib/ffmpeg";
import { safeUnlink } from "@/lib/cleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_FORMATS = new Set<ClipFormat>(["landscape", "vertical", "square"]);

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { url, start, end, format, limit60 } = body;

  // Validate format
  if (!format || !VALID_FORMATS.has(format as ClipFormat)) {
    return jsonError("Invalid format. Must be: landscape, vertical, or square.", 400);
  }

  // Validate URL (async — includes DNS resolution for SSRF)
  const urlResult = await validateUrl(url);
  if (!urlResult.valid) {
    return jsonError(urlResult.error, 400);
  }

  // Validate times
  const shouldLimit = limit60 !== false; // default true
  const timeResult = validateTimes(start, end, shouldLimit);
  if ("error" in timeResult) {
    const maxClip = parseInt(process.env.MAX_CLIP_SECONDS || "60", 10);
    const status = timeResult.error.includes("exceeds") ? 413 : 400;
    return jsonError(timeResult.error, status);
  }

  const { startSec, duration } = timeResult;
  const { args, outPath } = buildFfmpegArgs({
    url: urlResult.url,
    startSec,
    duration,
    format: format as ClipFormat,
  });

  // Acquire semaphore slot
  await clipSemaphore.acquire();

  try {
    // Run FFmpeg
    await runFfmpeg(args);

    // Verify the output file exists
    const fileStat = await stat(outPath);
    if (fileStat.size === 0) {
      await safeUnlink(outPath);
      return jsonError("FFmpeg produced an empty file", 500);
    }

    // Stream the file back
    const fileStream = createReadStream(outPath);
    const webStream = Readable.toWeb(fileStream) as ReadableStream;

    // Schedule cleanup after the stream finishes
    fileStream.on("close", () => {
      safeUnlink(outPath);
    });

    return new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": 'attachment; filename="quickclip.mp4"',
        "Content-Length": fileStat.size.toString(),
      },
    });
  } catch (err) {
    await safeUnlink(outPath);

    if (err instanceof FfmpegTimeoutError) {
      return jsonError(err.message, 504);
    }
    if (err instanceof FfmpegProcessError) {
      console.error("FFmpeg error:", err.stderr.slice(-2000));
      return jsonError("FFmpeg processing failed. The URL may be unreachable or not a valid video.", 500);
    }
    console.error("Unexpected error:", err);
    return jsonError("Unexpected server error", 500);
  } finally {
    clipSemaphore.release();
  }
}
