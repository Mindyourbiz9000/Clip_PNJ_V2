import { NextRequest } from "next/server";
import { extractVideoId, fetchChatBatch } from "@/lib/twitchChat";
import { isTwitchUrl } from "@/lib/resolveUrl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * GET /api/chat?url=<twitch_vod_url>&offset=<seconds>&cursor=<cursor>
 *
 * Returns a batch of chat messages for the VOD starting at the given offset.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const url = searchParams.get("url");
  const offset = parseInt(searchParams.get("offset") ?? "0", 10);
  const cursor = searchParams.get("cursor") ?? undefined;

  if (!url || !isTwitchUrl(url)) {
    return jsonError("A valid Twitch VOD URL is required", 400);
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    return jsonError("Could not extract video ID from URL", 400);
  }

  try {
    const result = await fetchChatBatch(videoId, {
      startOffsetSeconds: offset,
      cursor,
      maxPages: 5,
    });

    return new Response(
      JSON.stringify({
        videoId,
        messages: result.messages,
        nextCursor: result.nextCursor,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Chat fetch error:", message);
    return jsonError(
      `Failed to fetch chat: ${message}`,
      502
    );
  }
}
