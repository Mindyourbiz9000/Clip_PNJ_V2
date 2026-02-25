/**
 * AI-powered highlight reranking using Claude Haiku.
 *
 * Takes candidate highlights from the rule-based system and uses an LLM
 * to understand the chat context, assess entertainment value, and
 * re-rank to surface the best moments.
 */

import Anthropic from "@anthropic-ai/sdk";
import { fetchChatBatch, type ChatMessage } from "./twitchChat";
import type { HypeMoment } from "./chatAnalyzer";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AIRating {
  /** Index of the candidate in the original array */
  index: number;
  /** AI entertainment score 0-10 */
  aiScore: number;
  /** 1-sentence description of what's happening */
  description: string;
}

/* ------------------------------------------------------------------ */
/*  Chat context fetching                                              */
/* ------------------------------------------------------------------ */

/**
 * Formats a timestamp as HH:MM:SS for chat display.
 */
function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [
    h.toString().padStart(2, "0"),
    m.toString().padStart(2, "0"),
    s.toString().padStart(2, "0"),
  ].join(":");
}

/**
 * Fetches ~90 seconds of chat context around each candidate moment.
 * Fetches are run in parallel (batches of 5) to stay reasonable on Twitch API.
 */
export async function fetchCandidateContexts(
  videoId: string,
  candidates: HypeMoment[]
): Promise<Map<number, ChatMessage[]>> {
  const contextMap = new Map<number, ChatMessage[]>();
  const BATCH_SIZE = 5;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (moment, batchIdx) => {
      const idx = i + batchIdx;
      // Fetch from 30s before the moment start to 30s after the moment end
      const fetchStart = Math.max(0, moment.startSec - 30);
      const fetchEnd = moment.endSec + 30;

      try {
        const { messages } = await fetchChatBatch(videoId, {
          startOffsetSeconds: fetchStart,
          maxPages: 5,
        });

        // Filter to our time window
        const relevant = messages.filter(
          (m) => m.offsetSeconds >= fetchStart && m.offsetSeconds <= fetchEnd
        );

        contextMap.set(idx, relevant);
      } catch {
        // If fetch fails for one candidate, use empty context
        contextMap.set(idx, []);
      }
    });

    await Promise.all(promises);
  }

  return contextMap;
}

/* ------------------------------------------------------------------ */
/*  AI prompt construction                                             */
/* ------------------------------------------------------------------ */

function buildPrompt(
  candidates: HypeMoment[],
  contextMap: Map<number, ChatMessage[]>
): string {
  let prompt = "";

  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    const messages = contextMap.get(i) ?? [];

    prompt += `\n--- CANDIDATE #${i + 1} ---\n`;
    prompt += `Time: ${fmtTime(m.startSec)} – ${fmtTime(m.endSec)}\n`;
    prompt += `Rule-based tag: ${m.tag} | Messages: ${m.messageCount} | Burst: ${m.burstScore.toFixed(1)}\n`;
    prompt += `Chat:\n`;

    if (messages.length === 0) {
      prompt += "(no chat context available)\n";
    } else {
      // Limit to ~60 messages per candidate to control token usage
      const sample = messages.length > 60
        ? messages.slice(0, 60)
        : messages;

      for (const msg of sample) {
        prompt += `[${fmtTime(msg.offsetSeconds)}] ${msg.author}: ${msg.text}\n`;
      }
    }
  }

  return prompt;
}

/* ------------------------------------------------------------------ */
/*  AI reranking                                                       */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `You are an expert at analyzing French Twitch chat to find the most entertaining and funny moments. You understand French internet slang (mdr, ptdr, jpp, trop drôle, etc.), Twitch emote culture (KEKW, LUL, OMEGALUL, PogChamp, monkaS, Sadge, etc.), and the social dynamics of live streaming communities.

Your task: For each candidate highlight, read the chat messages and rate its entertainment value.

Scoring guidelines:
- 9-10: Exceptionally funny/hype moment, clear peak in entertainment, strong varied reactions
- 7-8: Genuinely entertaining, strong chat reactions with conversational context
- 5-6: Decent moment, some reactions but nothing outstanding
- 3-4: Weak moment, mostly noise, repetitive spam, or routine chat activity
- 0-2: Not a real highlight, false positive from volume spike or bot spam

Pay special attention to:
- Humor that builds over multiple messages (callbacks, running jokes, escalation)
- Chat reacting to something the streamer said or did (even if you can't see the stream, you can infer from reactions)
- Genuine surprise/shock vs routine emote usage
- Quality and variety of reactions (diverse funny messages > copy-paste spam)
- Conversational context — what triggered the reaction?
- French humor and inside jokes

Respond ONLY with a valid JSON array. Each element must have exactly these fields:
- "index": the candidate number (1-based, matching the CANDIDATE # in the input)
- "aiScore": integer 0-10
- "description": a 1-sentence description in French of what seems to be happening

Example response format:
[{"index":1,"aiScore":8,"description":"Le chat explose de rire après une réaction inattendue du streamer"},{"index":2,"aiScore":3,"description":"Spam répétitif sans contexte intéressant"}]`;

/**
 * Sends candidates + chat context to Claude Haiku for entertainment scoring.
 * Returns null on any failure (caller should fall back to rule-based ranking).
 */
async function callAI(
  candidates: HypeMoment[],
  contextMap: Map<number, ChatMessage[]>
): Promise<AIRating[] | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const client = new Anthropic({ apiKey });
  const userPrompt = buildPrompt(candidates, contextMap);

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    // Extract text from response
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    // Parse JSON — handle potential markdown code fences
    const jsonStr = text.replace(/```json?\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed)) return null;

    // Validate and normalize
    const ratings: AIRating[] = [];
    for (const item of parsed) {
      if (
        typeof item.index === "number" &&
        typeof item.aiScore === "number" &&
        typeof item.description === "string"
      ) {
        ratings.push({
          index: item.index - 1, // Convert from 1-based to 0-based
          aiScore: Math.max(0, Math.min(10, Math.round(item.aiScore))),
          description: item.description.slice(0, 200),
        });
      }
    }

    return ratings.length > 0 ? ratings : null;
  } catch (err) {
    console.error("AI reranking failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Score blending & final selection                                    */
/* ------------------------------------------------------------------ */

/**
 * Blends rule-based scores with AI scores and selects the top N.
 * AI score is weighted 70% to let AI judgment take priority.
 */
function blendAndSelect(
  candidates: HypeMoment[],
  ratings: AIRating[],
  topN: number
): HypeMoment[] {
  // Map ratings by candidate index
  const ratingMap = new Map<number, AIRating>();
  for (const r of ratings) {
    ratingMap.set(r.index, r);
  }

  // Normalize rule-based scores to 0-10 range
  const maxRuleScore = Math.max(...candidates.map((c) => c.score), 1);

  // Score each candidate
  const scored = candidates.map((candidate, idx) => {
    const rating = ratingMap.get(idx);
    const normalizedRule = (candidate.score / maxRuleScore) * 10;

    let finalScore: number;
    let aiDescription: string | undefined;
    let aiScore: number | undefined;

    if (rating) {
      // Blend: 30% rule-based + 70% AI
      finalScore = normalizedRule * 0.3 + rating.aiScore * 0.7;
      aiDescription = rating.description;
      aiScore = rating.aiScore;
    } else {
      // No AI rating for this candidate — use rule-based only
      finalScore = normalizedRule;
    }

    return { candidate, finalScore, aiDescription, aiScore, idx };
  });

  // Sort by final score descending
  scored.sort((a, b) => b.finalScore - a.finalScore);

  // Greedy non-overlapping selection (same 60s gap as original)
  const minGap = 60;
  const selected: HypeMoment[] = [];
  const usedRanges: Array<[number, number]> = [];

  for (const entry of scored) {
    if (selected.length >= topN) break;

    const start = entry.candidate.startSec;
    const end = entry.candidate.endSec;

    const tooClose = usedRanges.some(
      ([s, e]) => start < e + minGap && end > s - minGap
    );
    if (tooClose) continue;

    selected.push({
      ...entry.candidate,
      score: entry.finalScore,
      aiDescription: entry.aiDescription,
      aiScore: entry.aiScore,
    });
    usedRanges.push([start, end]);
  }

  // Sort final results chronologically
  selected.sort((a, b) => a.startSec - b.startSec);

  return selected;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Re-ranks candidate highlights using AI analysis of chat context.
 *
 * @param videoId - The Twitch VOD video ID
 * @param candidates - Rule-based candidate highlights (typically 25)
 * @param topN - Number of final highlights to return (typically 10)
 * @returns Re-ranked highlights with AI descriptions, or null if AI unavailable
 */
export async function rerankHighlights(
  videoId: string,
  candidates: HypeMoment[],
  topN = 10
): Promise<{ moments: HypeMoment[]; aiPowered: boolean }> {
  // No API key → skip AI entirely
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      moments: candidates.slice(0, topN),
      aiPowered: false,
    };
  }

  try {
    // Fetch chat context for each candidate
    const contextMap = await fetchCandidateContexts(videoId, candidates);

    // Call AI for scoring
    const ratings = await callAI(candidates, contextMap);

    if (!ratings) {
      // AI failed — fall back to rule-based top N
      return {
        moments: candidates.slice(0, topN),
        aiPowered: false,
      };
    }

    // Blend scores and select final highlights
    const moments = blendAndSelect(candidates, ratings, topN);

    return { moments, aiPowered: true };
  } catch (err) {
    console.error("AI reranking error:", err instanceof Error ? err.message : err);
    return {
      moments: candidates.slice(0, topN),
      aiPowered: false,
    };
  }
}
