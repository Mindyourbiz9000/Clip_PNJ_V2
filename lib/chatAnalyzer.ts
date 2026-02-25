/**
 * Scores chat messages and detects "hype" moments in a Twitch VOD
 * by analyzing reaction patterns, emotes, message density, burst flooding,
 * and categorizing each highlight by its dominant type.
 */

import type { ChatMessage, ChatFragment } from "./twitchChat";

/* ------------------------------------------------------------------ */
/*  Highlight categories                                               */
/* ------------------------------------------------------------------ */

/**
 * Each highlight is tagged with its dominant category:
 *  - fun       : laughter, jokes, comedic reactions
 *  - hype      : poggers, let's go, insane plays, general excitement
 *  - ban       : bans, timeouts, moderation drama
 *  - sub       : subscriptions, gifted subs, sub trains
 *  - donation  : bits, cheers, donations, tips
 */
export type HighlightTag = "fun" | "hype" | "ban" | "sub" | "donation";

export const HIGHLIGHT_TAG_META: Record<HighlightTag, { label: string; emoji: string }> = {
  fun:      { label: "Fun",      emoji: "😂" },
  hype:     { label: "Hype",     emoji: "🔥" },
  ban:      { label: "Ban",      emoji: "🔨" },
  sub:      { label: "Sub",      emoji: "⭐" },
  donation: { label: "Donation", emoji: "💰" },
};

/* ------------------------------------------------------------------ */
/*  Categorized reaction patterns                                      */
/* ------------------------------------------------------------------ */

interface CategoryPatterns {
  keywords: RegExp[];
  emoteNames: Set<string>;
}

const CATEGORY_PATTERNS: Record<HighlightTag, CategoryPatterns> = {
  fun: {
    keywords: [
      // French laughter (strong signals only)
      /\bmdr\b/i,
      /\bptdr\b/i,
      /\bxptdr\b/i,
      /\bmort\s*de\s*rire\b/i,
      /\bjpp\b/i,
      // English laughter (strong signals only)
      /\blmao\b/i,
      /\blmfao\b/i,
      /\brofl\b/i,
      // Extended laughter patterns (must be genuine laughter, not just "lol")
      /ha(ha){2,}/i,
      /he(he){2,}/i,
      /x[dD]{2,}/,
      // Laughter emojis
      /😂|🤣/,
    ],
    emoteNames: new Set([
      "LUL", "LULW", "OMEGALUL", "KEKW", "ICANT", "pepeLaugh",
      "EleGiggle", "4Head",
    ]),
  },

  hype: {
    keywords: [
      // Strong hype signals only
      /\blets?\s*go+\b/i,
      /\blet'?s\s*go+\b/i,
      /\bpog(gers)?\b/i,
      /\bclip\s*(it|that|this)\b/i,
      /\binsane\b/i,
      /\bgod\s*(like|tier)\b/i,
      // Strong shock/surprise
      /\bomg\b/i,
      /\bwtf\b/i,
      /\bholy\s*(shit|cow|moly|f+)\b/i,
      /\bno\s*way\b/i,
      /🔥|😱/,
    ],
    emoteNames: new Set([
      "PogChamp", "Pog", "PogU", "POGGIES", "POGCRAZY",
      "Kreygasm", "HYPERS", "gachiGASM",
      "monkaS", "monkaW", "WutFace",
    ]),
  },

  ban: {
    keywords: [
      // ONLY exact Twitch system message for bans
      /has been banned/i,
    ],
    emoteNames: new Set([
      "crabrave", "crabPls",
    ]),
  },

  sub: {
    keywords: [
      // ONLY exact Twitch system message for mass gifting
      // (the number check >= 15 is handled in scoreMessage)
      /is gifting/i,
    ],
    emoteNames: new Set([]),
  },

  donation: {
    keywords: [
      // Bits / cheers (Twitch-specific)
      /\bcheer\d+/i,
      /\bbits\b/i,
      // Donation patterns
      /\bdon(o|at(e|ion|ed))\b/i,
      /\$\s*\d+/,
      /\b\d+\s*€/,
      /💰|💵|💲|💎|🎁|💸|🤑/,
    ],
    emoteNames: new Set([
      "HypeCheer",
    ]),
  },
};

/* ------------------------------------------------------------------ */
/*  Scoring                                                            */
/* ------------------------------------------------------------------ */

export interface CategoryScores {
  fun: number;
  hype: number;
  ban: number;
  sub: number;
  donation: number;
}

export interface MessageScore {
  reactionScore: number;
  emoteCount: number;
  categories: CategoryScores;
}

/** Score a single chat message and break down by category. */
export function scoreMessage(msg: ChatMessage): MessageScore {
  let reactionScore = 0;
  let emoteCount = 0;
  const categories: CategoryScores = { fun: 0, hype: 0, ban: 0, sub: 0, donation: 0 };

  const text = msg.text;

  // ── High-value event detection (exact Twitch system messages) ──

  // Ban: "has been banned" — big bonus so it always surfaces
  if (/has been banned/i.test(text)) {
    reactionScore += 15;
    categories.ban += 15;
  }

  // Sub gifting: "is gifting N" — only counts if N >= 15
  const giftMatch = text.match(/is gifting (\d+)/i);
  if (giftMatch) {
    const count = parseInt(giftMatch[1], 10);
    if (count >= 15) {
      // Scale bonus with gift count: 15 gifts = 10, 50 gifts = 20 (capped)
      const bonus = Math.min(Math.round(count * 0.6), 20);
      reactionScore += bonus;
      categories.sub += bonus;
    }
    // If < 15, do NOT score as sub at all — skip sub keyword matching below
  }

  // ── Emote scoring per fragment ──
  for (const frag of msg.fragments) {
    if (!frag.emote) continue;
    const emoteName = frag.text.trim();

    for (const cat of Object.keys(CATEGORY_PATTERNS) as Array<keyof typeof CATEGORY_PATTERNS>) {
      if (CATEGORY_PATTERNS[cat].emoteNames.has(emoteName)) {
        emoteCount++;
        reactionScore += 2;
        categories[cat] += 2;
        break; // one emote = one category
      }
    }
  }

  // ── Keyword scoring per category ──
  for (const cat of Object.keys(CATEGORY_PATTERNS) as Array<keyof typeof CATEGORY_PATTERNS>) {
    // Skip sub keyword matching for messages that are small gift events (< 15)
    // They already got 0 from the special handler above
    if (cat === "sub" && giftMatch && parseInt(giftMatch[1], 10) < 15) continue;
    // Skip sub keyword matching for non-gift messages (only system gift msgs count)
    if (cat === "sub" && !giftMatch) continue;

    for (const pattern of CATEGORY_PATTERNS[cat].keywords) {
      if (pattern.test(text)) {
        reactionScore += 1;
        categories[cat] += 1;
        break; // max 1 keyword match per category per message
      }
    }
  }

  // ── ALL CAPS detection (excitement indicator, min 5 chars) ──
  if (text.length >= 5 && text === text.toUpperCase() && /[A-Z]/.test(text)) {
    reactionScore += 0.5;
    categories.hype += 0.5;
  }

  return { reactionScore, emoteCount, categories };
}

/* ------------------------------------------------------------------ */
/*  Bucketing                                                          */
/* ------------------------------------------------------------------ */

export interface ChatBucket {
  startSec: number;
  messageCount: number;
  reactionScore: number;
  emoteCount: number;
  /** Per-category accumulated scores */
  categoryScores: CategoryScores;
  /** Timestamps of every message in this bucket (for burst detection) */
  messageTimestamps: number[];
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
        categoryScores: { fun: 0, hype: 0, ban: 0, sub: 0, donation: 0 },
        messageTimestamps: [],
        sampleMessages: [],
      };
      this.buckets.set(key, bucket);
    }

    bucket.messageCount++;
    bucket.messageTimestamps.push(msg.offsetSeconds);

    const { reactionScore, emoteCount, categories } = scoreMessage(msg);
    bucket.reactionScore += reactionScore;
    bucket.emoteCount += emoteCount;

    // Accumulate per-category scores
    bucket.categoryScores.fun += categories.fun;
    bucket.categoryScores.hype += categories.hype;
    bucket.categoryScores.ban += categories.ban;
    bucket.categoryScores.sub += categories.sub;
    bucket.categoryScores.donation += categories.donation;

    // Keep sample reaction messages for context (increased from 5 to 10)
    if (reactionScore > 0 && bucket.sampleMessages.length < 10) {
      const sample = msg.text.slice(0, 80);
      bucket.sampleMessages.push(sample);
    }
  }

  getBuckets(): Map<number, ChatBucket> {
    return this.buckets;
  }
}

/* ------------------------------------------------------------------ */
/*  Burst / flood detection                                            */
/* ------------------------------------------------------------------ */

/**
 * Detects message bursts within a bucket.
 * A burst is defined as N+ messages arriving within a short sub-window.
 * Returns a burst intensity score (0 = no burst, higher = more intense).
 */
function computeBurstScore(bucket: ChatBucket): number {
  const timestamps = bucket.messageTimestamps;
  if (timestamps.length < 10) return 0;

  // Sort timestamps and use a sliding 5-second sub-window
  const sorted = [...timestamps].sort((a, b) => a - b);
  const subWindow = 5; // seconds
  let maxInWindow = 0;

  let left = 0;
  for (let right = 0; right < sorted.length; right++) {
    while (sorted[right] - sorted[left] > subWindow) left++;
    const count = right - left + 1;
    if (count > maxInWindow) maxInWindow = count;
  }

  // Messages per second in the densest 5-second window
  const msgsPerSec = maxInWindow / subWindow;

  // Burst threshold: more than 5 msgs/sec in a 5s window is notable
  if (msgsPerSec < 5) return 0;

  // Scale: 5 msgs/s = score 5, 10 msgs/s = 20, 20 msgs/s = 60
  return Math.round(msgsPerSec * (msgsPerSec / 5) * 10) / 10;
}

/**
 * Detects copy-paste spam: if many messages in the bucket share identical text.
 * Returns a spam score (0 = no spam).
 */
function computeSpamScore(bucket: ChatBucket): number {
  const msgs = bucket.sampleMessages;
  if (msgs.length < 3) return 0;

  // Count duplicates across sample messages
  const freq = new Map<string, number>();
  for (const m of msgs) {
    const normalized = m.toLowerCase().trim();
    freq.set(normalized, (freq.get(normalized) ?? 0) + 1);
  }

  let maxFreq = 0;
  for (const count of freq.values()) {
    if (count > maxFreq) maxFreq = count;
  }

  // If 60%+ of sample messages are identical, it's a spam burst
  const spamRatio = maxFreq / msgs.length;
  if (spamRatio >= 0.6 && maxFreq >= 3) {
    return maxFreq * 3;
  }

  return 0;
}

/* ------------------------------------------------------------------ */
/*  Dominant tag resolution                                            */
/* ------------------------------------------------------------------ */

/**
 * Determines the dominant highlight tag for a bucket based on
 * category scores and burst intensity.
 */
function resolveDominantTag(
  bucket: ChatBucket,
  _burstScore: number,
  _spamScore: number
): HighlightTag {
  const cat = bucket.categoryScores;

  // Find highest category
  const entries: Array<[HighlightTag, number]> = [
    ["fun", cat.fun],
    ["hype", cat.hype],
    ["ban", cat.ban],
    ["sub", cat.sub],
    ["donation", cat.donation],
  ];
  entries.sort((a, b) => b[1] - a[1]);

  // Default to hype if nothing scored
  if (entries[0][1] === 0) return "hype";

  return entries[0][0];
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
  /** Dominant highlight type tag */
  tag: HighlightTag;
  /** Per-category score breakdown */
  categoryScores: CategoryScores;
  /** Burst intensity (messages flooding speed) */
  burstScore: number;
  /** Sample reaction messages */
  sampleMessages: string[];
}

/* ------------------------------------------------------------------ */
/*  Sliding-window scoring across adjacent buckets                     */
/* ------------------------------------------------------------------ */

interface WindowScore {
  /** Key of the central bucket */
  key: number;
  /** Composite score across the window */
  score: number;
  /** Merged bucket data from all buckets in the window */
  merged: ChatBucket;
  /** Burst score from the central bucket */
  burstScore: number;
  /** Spam score from the central bucket */
  spamScore: number;
  /** Velocity score — how fast activity ramped up */
  velocityScore: number;
  /** Unique message ratio (diversity of reactions) */
  uniqueRatio: number;
}

/**
 * Merges adjacent buckets into a single virtual bucket for sliding window
 * scoring. This captures moments where activity spans bucket boundaries.
 */
function mergeBuckets(bucketList: ChatBucket[]): ChatBucket {
  const merged: ChatBucket = {
    startSec: bucketList[0]?.startSec ?? 0,
    messageCount: 0,
    reactionScore: 0,
    emoteCount: 0,
    categoryScores: { fun: 0, hype: 0, ban: 0, sub: 0, donation: 0 },
    messageTimestamps: [],
    sampleMessages: [],
  };

  for (const b of bucketList) {
    merged.messageCount += b.messageCount;
    merged.reactionScore += b.reactionScore;
    merged.emoteCount += b.emoteCount;
    merged.categoryScores.fun += b.categoryScores.fun;
    merged.categoryScores.hype += b.categoryScores.hype;
    merged.categoryScores.ban += b.categoryScores.ban;
    merged.categoryScores.sub += b.categoryScores.sub;
    merged.categoryScores.donation += b.categoryScores.donation;
    merged.messageTimestamps.push(...b.messageTimestamps);
    // Collect sample messages from all buckets (up to 10)
    for (const s of b.sampleMessages) {
      if (merged.sampleMessages.length < 10) merged.sampleMessages.push(s);
    }
  }

  return merged;
}

/**
 * Computes how quickly chat activity ramped up leading into this bucket.
 * A sudden spike from quiet → active is more interesting than sustained
 * high activity. Returns a velocity multiplier (1.0 = no bonus).
 */
function computeVelocityScore(
  keys: number[],
  buckets: Map<number, ChatBucket>,
  currentIdx: number
): number {
  const curr = buckets.get(keys[currentIdx]);
  if (!curr || currentIdx === 0) return 1.0;

  // Look at the 2 preceding buckets for baseline
  let prevTotal = 0;
  let prevCount = 0;
  for (let i = Math.max(0, currentIdx - 2); i < currentIdx; i++) {
    const b = buckets.get(keys[i]);
    if (b) {
      prevTotal += b.messageCount;
      prevCount++;
    }
  }

  if (prevCount === 0) return 1.0;
  const prevAvg = prevTotal / prevCount;

  // Ratio of current activity vs. prior average
  if (prevAvg < 1) {
    // If prior was near-silent, any activity is a big spike
    return curr.messageCount > 5 ? 2.0 : 1.0;
  }

  const ratio = curr.messageCount / prevAvg;

  // Ramp-up scoring: ratio >= 3 = big spike, 2 = moderate, <1.5 = no bonus
  if (ratio >= 4) return 2.5;
  if (ratio >= 3) return 2.0;
  if (ratio >= 2) return 1.5;
  if (ratio >= 1.5) return 1.2;
  return 1.0;
}

/**
 * Computes a unique message ratio — diverse reactions indicate a genuine
 * exciting moment, while identical messages suggest copy-paste spam.
 * Returns 0..1 where 1 = all messages are unique.
 */
function computeUniqueRatio(bucket: ChatBucket): number {
  const msgs = bucket.sampleMessages;
  if (msgs.length < 2) return 1.0;

  const normalized = new Set(msgs.map((m) => m.toLowerCase().trim()));
  return normalized.size / msgs.length;
}

/**
 * Finds all significant hype moments from the bucketed chat data.
 *
 * Uses a sliding window across adjacent buckets, velocity detection
 * for sudden spikes, and adaptive thresholding to return ALL
 * statistically significant highlights (no fixed limit).
 *
 * Each moment is tagged with its dominant highlight category.
 */
export function findHypeMoments(
  buckets: Map<number, ChatBucket>,
  opts?: {
    windowSec?: number;
    clipDurationSec?: number;
    minGapSec?: number;
    /** Minimum score threshold as a factor of mean+stddev. Default 1.0 */
    thresholdFactor?: number;
    /** Optional hard cap (0 = no limit). Default 0 (unlimited) */
    maxHighlights?: number;
  }
): HypeMoment[] {
  const windowSec = opts?.windowSec ?? 30;
  const clipDuration = opts?.clipDurationSec ?? 30;
  const minGap = opts?.minGapSec ?? 45;
  const thresholdFactor = opts?.thresholdFactor ?? 1.0;
  const maxHighlights = opts?.maxHighlights ?? 0; // 0 = unlimited

  if (buckets.size === 0) return [];

  // Sort bucket keys
  const keys = Array.from(buckets.keys()).sort((a, b) => a - b);

  // ---- Phase 1: Score each bucket with sliding window ----
  // For each bucket, also consider its immediate neighbor to capture
  // moments that span bucket boundaries.
  const windowScores: WindowScore[] = keys.map((key, idx) => {
    const center = buckets.get(key)!;
    const burst = computeBurstScore(center);
    const spam = computeSpamScore(center);
    const velocity = computeVelocityScore(keys, buckets, idx);
    const uniqueRatio = computeUniqueRatio(center);

    // Merge with adjacent bucket if it exists (sliding window)
    const adjacentBuckets = [center];
    const nextKey = keys[idx + 1];
    if (nextKey !== undefined) {
      const next = buckets.get(nextKey);
      if (next) adjacentBuckets.push(next);
    }
    const merged = adjacentBuckets.length > 1 ? mergeBuckets(adjacentBuckets) : center;

    // Improved scoring formula:
    // - messageCount: base activity
    // - reactionScore * 3: weighted recognized reactions
    // - emoteCount * 2: emote richness
    // - burst * 0.5: burst bonus
    // - velocity multiplier: reward sudden spikes
    // - uniqueRatio: diversity bonus (0.5 to 1.0 range)
    const diversityBonus = 0.5 + uniqueRatio * 0.5; // Range: 0.5..1.0
    const rawScore =
      merged.messageCount +
      merged.reactionScore * 3 +
      merged.emoteCount * 2 +
      burst * 0.5;
    const score = rawScore * velocity * diversityBonus;

    return {
      key,
      score,
      merged,
      burstScore: burst,
      spamScore: spam,
      velocityScore: velocity,
      uniqueRatio,
    };
  });

  // ---- Phase 2: Adaptive threshold ----
  // Only keep moments that are significantly above average activity.
  // Use mean + thresholdFactor * stddev as the cutoff.
  const scores = windowScores.map((w) => w.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance =
    scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
  const stddev = Math.sqrt(variance);
  const threshold = mean + thresholdFactor * stddev;

  // Filter to only above-threshold buckets
  const candidates = windowScores
    .filter((w) => w.score >= threshold)
    .sort((a, b) => b.score - a.score);

  // ---- Phase 3: Greedy non-overlapping selection ----
  const selected: HypeMoment[] = [];
  const usedRanges: Array<[number, number]> = [];

  for (const entry of candidates) {
    if (maxHighlights > 0 && selected.length >= maxHighlights) break;

    // Shift start back to account for chat reaction delay —
    // viewers react AFTER the moment happens on stream.
    const reactionDelay = 20;
    const start = Math.max(0, entry.key - reactionDelay);
    const end = start + clipDuration;

    // Check if too close to an already-selected moment
    const tooClose = usedRanges.some(
      ([s, e]) => start < e + minGap && end > s - minGap
    );
    if (tooClose) continue;

    const b = entry.merged;
    const tag = resolveDominantTag(b, entry.burstScore, entry.spamScore);

    selected.push({
      startSec: start,
      endSec: end,
      score: entry.score,
      messagesPerSec: Math.round((b.messageCount / windowSec) * 10) / 10,
      messageCount: b.messageCount,
      tag,
      categoryScores: { ...b.categoryScores },
      burstScore: entry.burstScore,
      sampleMessages: b.sampleMessages,
    });
    usedRanges.push([start, end]);
  }

  // Sort final results by time (chronological order)
  selected.sort((a, b) => a.startSec - b.startSec);

  return selected;
}
