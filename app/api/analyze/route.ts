import { NextRequest } from "next/server";
import { extractVideoId, iterateChat } from "@/lib/twitchChat";
import { BucketAccumulator, findHypeMoments } from "@/lib/chatAnalyzer";
import { isTwitchUrl } from "@/lib/resolveUrl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Max pages to fetch — safety valve (~100 msgs/page). */
const MAX_PAGES = 15_000;
/** Analysis timeout in ms (3 minutes). */
const ANALYSIS_TIMEOUT_MS = 180_000;

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

  const { url } = body;

  if (typeof url !== "string" || !url.trim()) {
    return jsonError("URL is required", 400);
  }

  if (!isTwitchUrl(url)) {
    return jsonError("Only Twitch VOD URLs are supported for chat analysis", 400);
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    return jsonError("Could not extract video ID from URL", 400);
  }

  const accumulator = new BucketAccumulator(30); // 30-second windows
  const startTime = Date.now();

  try {
    await iterateChat(
      videoId,
      (messages) => {
        for (const msg of messages) {
          accumulator.addMessage(msg);
        }

        // Check timeout within the callback
        if (Date.now() - startTime > ANALYSIS_TIMEOUT_MS) {
          throw new AnalysisTimeoutError();
        }
      },
      { maxPages: MAX_PAGES }
    );
  } catch (err) {
    if (err instanceof AnalysisTimeoutError) {
      // Return partial results from what we've processed so far
      console.log("Analysis timed out, returning partial results");
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Chat fetch error:", message);
      return jsonError(
        `Failed to fetch chat: ${message}`,
        502
      );
    }
  }

  const buckets = accumulator.getBuckets();

  if (buckets.size === 0) {
    return jsonError("No chat messages found for this video", 404);
  }

  const moments = findHypeMoments(buckets, {
    windowSec: 30,
    clipDurationSec: 30,
    minGapSec: 45,
    thresholdFactor: 1.0,
    maxHighlights: 0, // No limit — return all significant highlights
  });

  // Compute some stats for the response
  let totalMessages = 0;
  for (const b of buckets.values()) {
    totalMessages += b.messageCount;
  }

  return new Response(
    JSON.stringify({
      videoId,
      totalMessages,
      bucketsAnalyzed: buckets.size,
      moments,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

class AnalysisTimeoutError extends Error {
  constructor() {
    super("Analysis timed out");
  }
}
