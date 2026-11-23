import { NextRequest } from "next/server";
import { extractVideoId, fetchChatBatch, type ChatMessage } from "@/lib/twitchChat";
import { isTwitchUrl } from "@/lib/resolveUrl";
import { KeywordMatcher, sanitizeKeywords } from "@/lib/keywords";
import { analyzeContext } from "@/lib/contextAnalyzer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Chat window fetched around the peak (seconds before / after). */
const BEFORE_SEC = 60;
const AFTER_SEC = 40;
/** Safety valve: Twitch pages hold ~50-100 messages. */
const MAX_PAGES = 40;

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * POST /api/context  { url, peakSec, keywords? }
 * Returns the chat around a highlight plus a rule-based title and verdict.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { url, peakSec } = body;
  if (typeof url !== "string" || !isTwitchUrl(url)) {
    return jsonError("A valid Twitch VOD URL is required", 400);
  }
  const videoId = extractVideoId(url);
  if (!videoId) return jsonError("Could not extract video ID from URL", 400);
  if (typeof peakSec !== "number" || !Number.isFinite(peakSec) || peakSec < 0) {
    return jsonError("peakSec must be a positive number", 400);
  }

  const matcher = new KeywordMatcher(sanitizeKeywords(body.keywords));
  const from = Math.max(0, Math.floor(peakSec - BEFORE_SEC));
  const until = peakSec + AFTER_SEC;

  try {
    const messages: ChatMessage[] = [];
    let cursor: string | undefined;
    let pages = 0;
    // First batch by offset, then follow the cursor until we pass the window
    while (pages < MAX_PAGES) {
      const batch = await fetchChatBatch(videoId, {
        startOffsetSeconds: cursor ? undefined : from,
        cursor,
        maxPages: 5,
      });
      pages += 5;
      messages.push(...batch.messages.filter((m) => m.offsetSeconds >= from && m.offsetSeconds <= until));
      const last = batch.messages[batch.messages.length - 1];
      if (!batch.nextCursor || !last || last.offsetSeconds > until) break;
      cursor = batch.nextCursor;
    }

    return new Response(JSON.stringify(analyzeContext(messages, peakSec, matcher)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Context fetch error:", message);
    return jsonError(`Failed to fetch chat: ${message}`, 502);
  }
}
