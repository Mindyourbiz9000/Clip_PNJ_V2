import { NextRequest } from "next/server";
import { extractVideoId, iterateChat, ChatMessage } from "@/lib/twitchChat";
import { isTwitchUrl } from "@/lib/resolveUrl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface SearchHit {
  offsetSeconds: number;
  text: string;
}

/**
 * GET /api/chat/search?url=<twitch_vod_url>&q=<search_query>
 *
 * Scans the entire VOD chat and returns messages matching the query.
 * Results are capped at 100 hits to keep response sizes reasonable.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const url = searchParams.get("url");
  const query = searchParams.get("q")?.trim();

  if (!url || !isTwitchUrl(url)) {
    return jsonError("A valid Twitch VOD URL is required", 400);
  }

  if (!query || query.length < 2) {
    return jsonError("Search query must be at least 2 characters", 400);
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    return jsonError("Could not extract video ID from URL", 400);
  }

  const MAX_HITS = 100;
  const hits: SearchHit[] = [];
  const lowerQuery = query.toLowerCase();

  try {
    await iterateChat(
      videoId,
      (batch: ChatMessage[]) => {
        if (hits.length >= MAX_HITS) return;
        for (const msg of batch) {
          if (hits.length >= MAX_HITS) break;
          if (msg.text.toLowerCase().includes(lowerQuery)) {
            hits.push({
              offsetSeconds: msg.offsetSeconds,
              text: msg.text,
            });
          }
        }
      },
      { maxPages: 10_000 }
    );

    return new Response(
      JSON.stringify({ videoId, query, hits, totalHits: hits.length }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Chat search error:", message);
    return jsonError(`Failed to search chat: ${message}`, 502);
  }
}
