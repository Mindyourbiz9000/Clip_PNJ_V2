/**
 * Scores chat messages and detects "hype" moments in a Twitch VOD
 * by analyzing reaction patterns, emotes, and message density.
 */

import type { ChatMessage, ChatFragment } from "./twitchChat";

/* ------------------------------------------------------------------ */
/*  Reaction patterns                                                  */
/* ------------------------------------------------------------------ */

/** Case-insensitive keywords that indicate a reaction */
const REACTION_KEYWORDS: RegExp[] = [
  // French reactions
  /\bmdr\b/i,
  /\bptdr\b/i,
  /\bxptdr\b/i,
  /\btrop dr[oô]le\b/i,
  /\bmort\s*de\s*rire\b/i,
  /\bjpp\b/i,
  /\bjsp\b/i,

  // English reactions
  /\blol\b/i,
  /\blmao\b/i,
  /\blmfao\b/i,
  /\brofl\b/i,
  /\bomg\b/i,
  /\bwtf\b/i,
  /\bw[t]?f\b/i,

  // Laughter patterns
  /ha(ha)+/i,
  /he(he)+/i,
  /ja(ja)+/i,
  /x[dD]+/,
  /😂|🤣|😭|💀|❤️?|🔥|💯|😍|🥰|😱|👏|🎉|❤/,

  // Hype / excitement
  /\blets?\s*go+\b/i,
  /\bgg\b/i,
  /\bpog\b/i,
  /\bpoggers\b/i,
  /\bclip\s*(it|that)\b/i,
  /\bclipped\b/i,
  /\binsane\b/i,
  /\bcrazy\b/i,
  /\bno\s*way\b/i,
  /!{3,}/,  // "!!!" excitement
];

/** Twitch emote names that indicate strong reactions */
const HYPE_EMOTE_NAMES = new Set([
  // Laughter
  "LUL", "LULW", "OMEGALUL", "KEKW", "ICANT", "pepeLaugh",
  "EleGiggle", "4Head",
  // Hype / PogChamp family
  "PogChamp", "Pog", "PogU", "PogSlide", "POGGIES",
  // Emotional
  "PepeHands", "Sadge", "BibleThump", "FeelsBadMan", "FeelsGoodMan",
  "catJAM", "Kreygasm",
  // Surprise / shock
  "monkaS", "monkaW", "WutFace", "D:",
  // Love
  "peepoLove", "peepoHappy", "<3",
  // General hype
  "EZ", "COPIUM", "Clap",
]);

/* ------------------------------------------------------------------ */
/*  Scoring                                                            */
/* ------------------------------------------------------------------ */

export interface MessageScore {
  reactionScore: number;
  emoteCount: number;
}

/** Score a single chat message for "hype" content. */
export function scoreMessage(msg: ChatMessage): MessageScore {
  let reactionScore = 0;
  let emoteCount = 0;

  // Check for hype emotes in fragments
  for (const frag of msg.fragments) {
    if (frag.emote && HYPE_EMOTE_NAMES.has(frag.text.trim())) {
      emoteCount++;
      reactionScore += 2;
    }
  }

  // Check full text against reaction patterns
  const text = msg.text;
  for (const pattern of REACTION_KEYWORDS) {
    if (pattern.test(text)) {
      reactionScore += 1;
      break; // count at most 1 keyword match per message
    }
  }

  // ALL CAPS messages (excitement indicator, min 5 chars to avoid false positives)
  if (text.length >= 5 && text === text.toUpperCase() && /[A-Z]/.test(text)) {
    reactionScore += 0.5;
  }

  return { reactionScore, emoteCount };
}

/* ------------------------------------------------------------------ */
/*  Bucketing                                                          */
/* ------------------------------------------------------------------ */

export interface ChatBucket {
  startSec: number;
  messageCount: number;
  reactionScore: number;
  emoteCount: number;
  /** A few sample reaction messages to display as context */
  sampleMessages: string[];
}

export class BucketAccumulator {
  private buckets = new Map<number, ChatBucket>();
  private windowSec: number;

  constructor(windowSec = 30) {
    this.windowSec = windowSec;
  }

  addMessage(msg: ChatMessage): void {
    const key = Math.floor(msg.offsetSeconds / this.windowSec) * this.windowSec;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        startSec: key,
        messageCount: 0,
        reactionScore: 0,
        emoteCount: 0,
        sampleMessages: [],
      };
      this.buckets.set(key, bucket);
    }

    bucket.messageCount++;
    const { reactionScore, emoteCount } = scoreMessage(msg);
    bucket.reactionScore += reactionScore;
    bucket.emoteCount += emoteCount;

    // Keep a few sample reaction messages for context
    if (reactionScore > 0 && bucket.sampleMessages.length < 5) {
      const sample = msg.text.slice(0, 80);
      bucket.sampleMessages.push(sample);
    }
  }

  getBuckets(): Map<number, ChatBucket> {
    return this.buckets;
  }
}

/* ------------------------------------------------------------------ */
/*  Peak detection                                                     */
/* ------------------------------------------------------------------ */

export interface HypeMoment {
  /** Start of the clip window in seconds */
  startSec: number;
  /** End of the clip window in seconds */
  endSec: number;
  /** Composite hype score */
  score: number;
  /** Messages per second in this window */
  messagesPerSec: number;
  /** Total messages in the window */
  messageCount: number;
  /** Sample reaction messages */
  sampleMessages: string[];
}

/**
 * Finds the top hype moments from the bucketed chat data.
 *
 * Uses a sliding window (summing adjacent buckets) then greedily
 * picks non-overlapping peaks.
 */
export function findHypeMoments(
  buckets: Map<number, ChatBucket>,
  opts?: {
    windowSec?: number;
    clipDurationSec?: number;
    minGapSec?: number;
    topN?: number;
  }
): HypeMoment[] {
  const windowSec = opts?.windowSec ?? 30;
  const clipDuration = opts?.clipDurationSec ?? 30;
  const minGap = opts?.minGapSec ?? 60;
  const topN = opts?.topN ?? 10;

  if (buckets.size === 0) return [];

  // Sort bucket keys
  const keys = Array.from(buckets.keys()).sort((a, b) => a - b);

  // Compute composite score for each bucket
  // Score = messageCount + reactionScore * 3 + emoteCount * 2
  const scored: Array<{ key: number; score: number; bucket: ChatBucket }> = keys.map(
    (key) => {
      const b = buckets.get(key)!;
      const score = b.messageCount + b.reactionScore * 3 + b.emoteCount * 2;
      return { key, score, bucket: b };
    }
  );

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Greedily pick non-overlapping peaks
  const selected: HypeMoment[] = [];
  const usedRanges: Array<[number, number]> = [];

  for (const entry of scored) {
    if (selected.length >= topN) break;

    const start = entry.key;
    const end = start + clipDuration;

    // Check if too close to an already-selected moment
    const tooClose = usedRanges.some(
      ([s, e]) => start < e + minGap && end > s - minGap
    );
    if (tooClose) continue;

    const b = entry.bucket;
    selected.push({
      startSec: start,
      endSec: end,
      score: entry.score,
      messagesPerSec: Math.round((b.messageCount / windowSec) * 10) / 10,
      messageCount: b.messageCount,
      sampleMessages: b.sampleMessages,
    });
    usedRanges.push([start, end]);
  }

  // Sort final results by time (chronological order)
  selected.sort((a, b) => a.startSec - b.startSec);

  return selected;
}
