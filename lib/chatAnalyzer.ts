/**
 * Scores chat messages and detects "hype" moments in a Twitch VOD
 * by analyzing reaction patterns, emotes, message density, burst flooding,
 * and categorizing each highlight by its dominant type.
 */

import type { ChatMessage } from "./twitchChat";
import { KeywordMatcher, type KeywordMatches } from "./keywords";

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
/*  Keyword-based scoring                                              */
/* ------------------------------------------------------------------ */

/**
 * Laugh intensity of one message from its matched "fun" keywords:
 * 0 = no laughter, 1 = laughs, up to 3 = laughing really hard
 * (several laugh words, long "hahahaha", "MDRRRR" typed in caps...).
 */
function laughFromMatches(text: string, funMatches: string[]): number {
  if (funMatches.length === 0) return 0;
  let points = Math.min(funMatches.length, 2);
  if (/(ha|ah|ja|xd|r){4,}/i.test(text) || /(😂|🤣|💀|😭){3,}/u.test(text)) points++;
  // Typed laughter in caps ("MDR", "PTDR"), not an emote that is caps anyway
  const typedInCaps = funMatches.some((k) => k !== k.toUpperCase());
  if (typedInCaps && text.length >= 3 && text === text.toUpperCase() && /[A-Z]{3,}/.test(text)) {
    points += 0.5;
  }
  return Math.min(points, 3);
}

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
  /** Laugh intensity 0..3 */
  laugh: number;
  /** Keywords found in this message, by category */
  matches: KeywordMatches;
}

/** Score a single chat message and break down by category. */
export function scoreMessage(msg: ChatMessage, matcher: KeywordMatcher): MessageScore {
  let reactionScore = 0;
  let emoteCount = 0;
  const categories: CategoryScores = { fun: 0, hype: 0, ban: 0, sub: 0, donation: 0 };
  const text = msg.text;

  // ── Twitch system messages (always on, not editable) ──
  if (/has been banned/i.test(text)) {
    reactionScore += 15;
    categories.ban += 15;
  }
  const giftMatch = text.match(/is gifting (\d+)/i);
  if (giftMatch) {
    const count = parseInt(giftMatch[1], 10);
    if (count >= 15) {
      // 15 gifts = 9, 50 gifts = 20 (capped)
      const bonus = Math.min(Math.round(count * 0.6), 20);
      reactionScore += bonus;
      categories.sub += bonus;
    }
  }

  // ── Editable keywords ──
  const matches = matcher.match(text);

  const laugh = laughFromMatches(text, matches.fun);
  if (laugh > 0) {
    reactionScore += laugh * 2;
    categories.fun += laugh * 2;
  }
  if (matches.hype.length > 0) {
    const pts = Math.min(matches.hype.length, 3) * 1.5;
    reactionScore += pts;
    categories.hype += pts;
  }
  if (matches.donation.length > 0) {
    const pts = Math.min(matches.donation.length, 3) * 1.5;
    reactionScore += pts;
    categories.donation += pts;
  }

  // Native Twitch emotes that are in the keyword lists
  for (const frag of msg.fragments) {
    if (frag.emote && matcher.isKeyword(frag.text)) emoteCount++;
  }

  // ── ALL CAPS (excitement indicator, min 5 chars) ──
  if (text.length >= 5 && text === text.toUpperCase() && /[A-Z]/.test(text)) {
    reactionScore += 0.5;
    categories.hype += 0.5;
  }

  return { reactionScore, emoteCount, categories, laugh, matches };
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
  /** Number of messages containing laughter */
  laughMessages: number;
  /** Sum of laugh intensities */
  laughIntensity: number;
  /** Distinct chatters who laughed (a real funny moment = many people laughing) */
  laughers: Set<string>;
  /** Timestamps of laughing messages (to center the clip on the laugh peak) */
  laughTimestamps: number[];
  /** How many times each keyword was used ("fun:KEKW" -> 23) */
  keywordHits: Map<string, number>;
}

function emptyBucket(startSec: number): ChatBucket {
  return {
    startSec,
    messageCount: 0,
    reactionScore: 0,
    emoteCount: 0,
    categoryScores: { fun: 0, hype: 0, ban: 0, sub: 0, donation: 0 },
    messageTimestamps: [],
    sampleMessages: [],
    laughMessages: 0,
    laughIntensity: 0,
    laughers: new Set(),
    laughTimestamps: [],
    keywordHits: new Map(),
  };
}

export class BucketAccumulator {
  private buckets = new Map<number, ChatBucket>();
  private windowSec: number;

  private matcher: KeywordMatcher;

  constructor(windowSec: number, matcher: KeywordMatcher) {
    this.windowSec = windowSec;
    this.matcher = matcher;
  }

  addMessage(msg: ChatMessage): void {
    const key = Math.floor(msg.offsetSeconds / this.windowSec) * this.windowSec;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = emptyBucket(key);
      this.buckets.set(key, bucket);
    }

    bucket.messageCount++;
    bucket.messageTimestamps.push(msg.offsetSeconds);

    const { reactionScore, emoteCount, categories, laugh, matches } = scoreMessage(msg, this.matcher);
    for (const cat of ["fun", "hype", "donation"] as const) {
      for (const kw of new Set(matches[cat])) {
        const k = `${cat}:${kw}`;
        bucket.keywordHits.set(k, (bucket.keywordHits.get(k) ?? 0) + 1);
      }
    }
    if (laugh > 0) {
      bucket.laughMessages++;
      bucket.laughIntensity += laugh;
      bucket.laughers.add(msg.author || `anon-${bucket.laughMessages}`);
      bucket.laughTimestamps.push(msg.offsetSeconds);
    }
    bucket.reactionScore += reactionScore;
    bucket.emoteCount += emoteCount;

    // Accumulate per-category scores
    bucket.categoryScores.fun += categories.fun;
    bucket.categoryScores.hype += categories.hype;
    bucket.categoryScores.ban += categories.ban;
    bucket.categoryScores.sub += categories.sub;
    bucket.categoryScores.donation += categories.donation;

    // Keep sample reaction messages for context (laughs first: they explain the clip)
    if (laugh > 0 && bucket.sampleMessages.length >= 10) {
      const idx = bucket.sampleMessages.findIndex((m) => this.matcher.match(m).fun.length === 0);
      if (idx >= 0) bucket.sampleMessages[idx] = msg.text.slice(0, 80);
    } else if (reactionScore > 0 && bucket.sampleMessages.length < 10) {
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
  /** Second when chat reacted the hardest (used for the context view) */
  peakSec: number;
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
  /** Keywords that triggered this highlight, most used first */
  keywords: Array<{ category: "fun" | "hype" | "donation"; word: string; count: number }>;
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
  /** Laughter-only score (see computeFunScore) */
  funScore: number;
}

/**
 * Laughter-only score for a window. What makes a moment really funny:
 *  - many DIFFERENT chatters laughing (not one person spamming KEKW),
 *  - a big share of chat laughing (works on small streams too),
 *  - laughter that suddenly appears compared to the minute before.
 */
function computeFunScore(
  merged: ChatBucket,
  keys: number[],
  buckets: Map<number, ChatBucket>,
  idx: number
): number {
  const laughers = merged.laughers.size;
  if (laughers < 4) return 0;

  const laughRatio = merged.laughMessages / Math.max(merged.messageCount, 1);

  // Baseline laughter in the 2 previous buckets
  let prevLaughers = 0;
  let prevCount = 0;
  for (let i = Math.max(0, idx - 2); i < idx; i++) {
    const b = buckets.get(keys[i]);
    if (b) {
      prevLaughers += b.laughers.size;
      prevCount++;
    }
  }
  const prevAvg = prevCount ? prevLaughers / prevCount : 0;
  const spike = laughers / Math.max(prevAvg * 2, 1); // merged = 2 buckets
  const spikeBonus = spike >= 4 ? 1.6 : spike >= 2.5 ? 1.35 : spike >= 1.5 ? 1.15 : 1.0;

  const base = laughers * 3 + merged.laughIntensity;
  const ratioBonus = 1 + Math.min(laughRatio, 0.6) * 2; // 1.0 .. 2.2
  return base * ratioBonus * spikeBonus;
}

/** Most used keywords of a window, e.g. [{ fun, KEKW, 23 }, ...]. */
function topKeywords(hits: Map<string, number>, max: number): HypeMoment["keywords"] {
  return Array.from(hits.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([k, count]) => {
      const i = k.indexOf(":");
      return { category: k.slice(0, i) as "fun" | "hype" | "donation", word: k.slice(i + 1), count };
    });
}

/**
 * Picks the moment chat reacted hardest: the center of the densest
 * 8-second window of the given timestamps.
 */
function peakTime(timestamps: number[], fallback: number): number {
  if (timestamps.length === 0) return fallback;
  const sorted = [...timestamps].sort((a, b) => a - b);
  let best = 0;
  let bestLeft = 0;
  let bestRight = 0;
  let left = 0;
  for (let right = 0; right < sorted.length; right++) {
    while (sorted[right] - sorted[left] > 8) left++;
    if (right - left + 1 > best) {
      best = right - left + 1;
      bestLeft = left;
      bestRight = right;
    }
  }
  return (sorted[bestLeft] + sorted[bestRight]) / 2;
}

/**
 * Merges adjacent buckets into a single virtual bucket for sliding window
 * scoring. This captures moments where activity spans bucket boundaries.
 */
function mergeBuckets(bucketList: ChatBucket[]): ChatBucket {
  const merged = emptyBucket(bucketList[0]?.startSec ?? 0);

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
    merged.laughMessages += b.laughMessages;
    merged.laughIntensity += b.laughIntensity;
    for (const a of b.laughers) merged.laughers.add(a);
    merged.laughTimestamps.push(...b.laughTimestamps);
    for (const [k, n] of b.keywordHits) merged.keywordHits.set(k, (merged.keywordHits.get(k) ?? 0) + n);
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
    /**
     * Slots reserved for funny moments, picked first by a laughter-only
     * score so they are not crowded out by sub trains or raids. Default 0.
     */
    funQuota?: number;
  }
): HypeMoment[] {
  const windowSec = opts?.windowSec ?? 30;
  const clipDuration = opts?.clipDurationSec ?? 30;
  const minGap = opts?.minGapSec ?? 45;
  const thresholdFactor = opts?.thresholdFactor ?? 1.0;
  const maxHighlights = opts?.maxHighlights ?? 0; // 0 = unlimited
  const funQuota = opts?.funQuota ?? 0;

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
      funScore: computeFunScore(merged, keys, buckets, idx),
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
  const usedKeys = new Set<number>();

  const tryAdd = (entry: WindowScore, forcedTag?: HighlightTag): boolean => {
    if (maxHighlights > 0 && selected.length >= maxHighlights) return false;
    if (usedKeys.has(entry.key)) return false;

    const b = entry.merged;
    const tag = forcedTag ?? resolveDominantTag(b, entry.burstScore, entry.spamScore);

    // Chat reacts AFTER the moment (stream latency + typing time), so the
    // clip starts 20s before the reaction peak (setup + punchline) and ends
    // 10s after it (the streamer's own reaction).
    const peak =
      tag === "fun"
        ? peakTime(b.laughTimestamps, entry.key + windowSec / 2)
        : peakTime(b.messageTimestamps, entry.key + windowSec / 2);
    const start = Math.max(0, Math.round(peak - 20));
    const end = Math.round(peak + 10);

    const tooClose = usedRanges.some(
      ([s, e]) => start < e + minGap && end > s - minGap
    );
    if (tooClose) return false;

    selected.push({
      startSec: start,
      endSec: end,
      peakSec: Math.round(peak),
      score: Math.round((tag === "fun" ? Math.max(entry.score, entry.funScore) : entry.score) * 10) / 10,
      messagesPerSec: Math.round((b.messageCount / windowSec) * 10) / 10,
      messageCount: b.messageCount,
      tag,
      categoryScores: { ...b.categoryScores },
      burstScore: entry.burstScore,
      sampleMessages: b.sampleMessages,
      keywords: topKeywords(b.keywordHits, 8),
    });
    usedRanges.push([start, end]);
    usedKeys.add(entry.key);
    return true;
  };

  // 3a. Funny moments first, ranked by laughter only, with their own
  //     adaptive threshold (computed among windows where people laughed).
  if (funQuota > 0) {
    const funWindows = windowScores.filter((w) => w.funScore > 0);
    if (funWindows.length > 0) {
      // Relative to THIS stream: at least twice as many laughers as a
      // typical window, and at least 15% of the stream's best laugh.
      const avgLaughers =
        windowScores.reduce((sum, w) => sum + w.merged.laughers.size, 0) / windowScores.length;
      const bestFun = Math.max(...funWindows.map((w) => w.funScore));
      const funCandidates = funWindows
        .filter((w) => w.merged.laughers.size >= avgLaughers * 2 && w.funScore >= bestFun * 0.15)
        .sort((a, b) => b.funScore - a.funScore);
      let funCount = 0;
      for (const entry of funCandidates) {
        if (funCount >= funQuota) break;
        if (tryAdd(entry, "fun")) funCount++;
      }
    }
  }

  // 3b. Fill the remaining slots with the strongest moments of any kind.
  for (const entry of candidates) {
    if (maxHighlights > 0 && selected.length >= maxHighlights) break;
    tryAdd(entry);
  }

  // Sort final results by time (chronological order)
  selected.sort((a, b) => a.startSec - b.startSec);

  return selected;
}
