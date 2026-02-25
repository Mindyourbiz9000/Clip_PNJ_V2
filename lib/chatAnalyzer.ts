/**
 * Scores chat messages and detects "hype" moments in a Twitch VOD
 * by analyzing reaction patterns, emotes, message density, burst flooding,
 * and categorizing each highlight by its dominant type.
 */

import type { ChatMessage } from "./twitchChat";

/* ------------------------------------------------------------------ */
/*  Highlight categories                                               */
/* ------------------------------------------------------------------ */

/**
 * Each highlight is tagged with its dominant category:
 *  - fun       : laughter, jokes, comedic reactions
 *  - hype      : poggers, let's go, insane plays
 *  - shock     : wtf, omg, surprise, disbelief
 *  - love      : hearts, wholesome, love emotes
 *  - toxic     : insults, bans, timeouts, drama
 *  - spam      : chat flooding / copy-paste spam bursts
 */
export type HighlightTag = "fun" | "hype" | "shock" | "love" | "toxic" | "spam";

export const HIGHLIGHT_TAG_META: Record<HighlightTag, { label: string; emoji: string }> = {
  fun:   { label: "Fun",   emoji: "😂" },
  hype:  { label: "Hype",  emoji: "🔥" },
  shock: { label: "Shock", emoji: "😱" },
  love:  { label: "Love",  emoji: "❤️" },
  toxic: { label: "Toxic", emoji: "☠️" },
  spam:  { label: "Spam",  emoji: "🌊" },
};

/* ------------------------------------------------------------------ */
/*  Categorized reaction patterns                                      */
/* ------------------------------------------------------------------ */

interface CategoryPatterns {
  keywords: RegExp[];
  emoteNames: Set<string>;
}

const CATEGORY_PATTERNS: Record<Exclude<HighlightTag, "spam">, CategoryPatterns> = {
  fun: {
    keywords: [
      // French laughter
      /\bmdr\b/i,
      /\bptdr\b/i,
      /\bxptdr\b/i,
      /\btrop dr[oô]le\b/i,
      /\bmort\s*de\s*rire\b/i,
      /\bjpp\b/i,
      // English laughter
      /\blol\b/i,
      /\blmao\b/i,
      /\blmfao\b/i,
      /\brofl\b/i,
      // Laughter patterns
      /ha(ha){2,}/i,
      /he(he){2,}/i,
      /ja(ja){2,}/i,
      /x[dD]{1,}/,
      // Burp reactions (chat spams "EUWA" when streamer burps)
      /\beu+wa+\b/i,
      // Emojis — laughter / comedy
      /😂|🤣|😆|😹/,
    ],
    emoteNames: new Set([
      "LUL", "LULW", "OMEGALUL", "KEKW", "ICANT", "pepeLaugh",
      "EleGiggle", "4Head", "LUL_TK", "KEKHeim",
      "KEKLEO", "forsenLUL",
    ]),
  },

  hype: {
    keywords: [
      /\blets?\s*go+\b/i,
      /\blet'?s\s*go+\b/i,
      /\bgg\b/i,
      /\bpog\b/i,
      /\bpoggers\b/i,
      /\bclip\s*(it|that|this)\b/i,
      /\bclipped\b/i,
      /\binsane\b/i,
      /\bcrazy\b/i,
      /\bclean\b/i,
      /\bgod\s*(like|tier|damn)\b/i,
      /\bgoat\b/i,
      /\bmassi[fv]e?\b/i,
      /\bmonster\b/i,
      /\bcheat(s|ing|er)?\b/i,
      /\bbest\b/i,
      /\bunreal\b/i,
      /\bwow\b/i,
      /\bgg\s*(wp|ez)\b/i,
      /\bez\s*(clap|game)?\b/i,
      /\bW\b/,
      /!{3,}/,  // "!!!" excitement
      /🔥|💯|🎉|🏆|👑/,
    ],
    emoteNames: new Set([
      "PogChamp", "Pog", "PogU", "PogSlide", "POGGIES", "POGCRAZY",
      "catJAM", "Clap", "EZ", "COPIUM", "HOPIUM",
      "Kreygasm", "HYPERS", "gachiGASM", "PogBones",
    ]),
  },

  shock: {
    keywords: [
      /\bomg\b/i,
      /\bwtf\b/i,
      /\bwhat\b/i,
      /\bno\s*way\b/i,
      /\bwai?t\s*what\b/i,
      /\bholy\s*(shit|cow|moly|crap|f+)?\b/i,
      /\bbruh\b/i,
      /\bwhat\s*the\b/i,
      /\bexcuse\s*me\b/i,
      /\bjsp\b/i,
      /\boh\s*(my\s*)?(god|lord|no)\b/i,
      /\bdead\b/i,
      /\bje\s*suis\s*mort\b/i,
      /\bje\s*suis\s*choque\b/i,
      /\?{3,}/, // "???" confusion / shock
      /😱|😮|😲|😧|💀|😭|😳/,
    ],
    emoteNames: new Set([
      "monkaS", "monkaW", "monkaEyes", "monkaGIGA", "WutFace", "D:",
      "Jebaited", "NotLikeThis", "widepeepoSad", "monkaHmm",
    ]),
  },

  love: {
    keywords: [
      /\blove\b/i,
      /\bj'?aime\b/i,
      /\bje\s*t'?aime\b/i,
      /\bcute\b/i,
      /\badorable\b/i,
      /\bwholesome\b/i,
      /\baww+\b/i,
      /\bmerci\b/i,
      /\bthank\s*(you|u)\b/i,
      /\brespect\b/i,
      /\bproud\b/i,
      /❤️?|🥰|😍|🥺|💕|💗|💖|💛|😘|❤/,
    ],
    emoteNames: new Set([
      "peepoLove", "peepoHappy", "<3", "FeelsGoodMan", "widepeepoHappy",
      "peepoClap", "peepoBlush", "catHug", "BibleThump",
      "HeyGuys", "VirtualHug", "TwitchUnity",
    ]),
  },

  toxic: {
    keywords: [
      // Insults (FR + EN, deduplicated)
      /\bfdp\b/i,
      /\bntm\b/i,
      /\btg\b/i,
      /\bnul(le)?\b/i,
      /\bnoob\b/i,
      /\bbot\b/i,
      /\btrash\b/i,
      /\bdeg(eu|ueulasse)\b/i,
      /\bgarbage\b/i,
      /\btroll(ing|ed|er)?\b/i,
      /\btoxic\b/i,
      /\brage\s*(quit)?\b/i,
      /\bsalt(y)?\b/i,
      /\bcringe\b/i,
      // Bans / Moderation events
      /\bban(n?ed|s)?\b/i,
      /\btimeout\b/i,
      /\bmuted?\b/i,
      /\breport(ed)?\b/i,
      /\bkick(ed)?\b/i,
      /\brip\b/i,
      /\bF\b/,  // press F
      /\bL\b/,  // L = loss
      /🤡|💩|🖕|🤮|😡|🤬/,
    ],
    emoteNames: new Set([
      "Sadge", "PepeHands", "FeelsBadMan", "ResidentSleeper",
      "BabyRage", "SwiftRage", "DansGame",
      "FailFish", "SMOrc", "haHAA", "WeirdChamp", "Pepega",
    ]),
  },
};

/* ------------------------------------------------------------------ */
/*  Combined emote lookup for text-based recognition                   */
/* ------------------------------------------------------------------ */

/** Map every known emote name to its primary category (for text-only matching). */
const ALL_EMOTE_NAMES = new Map<string, Exclude<HighlightTag, "spam">>();
for (const cat of Object.keys(CATEGORY_PATTERNS) as Array<keyof typeof CATEGORY_PATTERNS>) {
  for (const emote of CATEGORY_PATTERNS[cat].emoteNames) {
    if (!ALL_EMOTE_NAMES.has(emote)) {
      ALL_EMOTE_NAMES.set(emote, cat);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Scoring                                                            */
/* ------------------------------------------------------------------ */

export interface CategoryScores {
  fun: number;
  hype: number;
  shock: number;
  love: number;
  toxic: number;
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
  const categories: CategoryScores = { fun: 0, hype: 0, shock: 0, love: 0, toxic: 0 };

  const text = msg.text;

  // Track emotes already scored via fragments to avoid double-counting
  const scoredEmotes = new Set<string>();

  // --- Emote scoring per fragment (actual Twitch emotes) ---
  for (const frag of msg.fragments) {
    if (!frag.emote) continue;
    const emoteName = frag.text.trim();

    for (const cat of Object.keys(CATEGORY_PATTERNS) as Array<keyof typeof CATEGORY_PATTERNS>) {
      if (CATEGORY_PATTERNS[cat].emoteNames.has(emoteName)) {
        emoteCount++;
        reactionScore += 2;
        categories[cat] += 2;
        scoredEmotes.add(emoteName);
        break; // one emote = one category
      }
    }
  }

  // --- Text-based emote recognition (non-subscribers typing emote names) ---
  for (const [emoteName, cat] of ALL_EMOTE_NAMES) {
    if (scoredEmotes.has(emoteName)) continue; // already scored as real emote
    if (text.includes(emoteName)) {
      reactionScore += 1; // reduced score for text-only mention
      categories[cat] += 1;
      break; // max 1 text-emote match per message
    }
  }

  // --- Keyword scoring per category ---
  for (const cat of Object.keys(CATEGORY_PATTERNS) as Array<keyof typeof CATEGORY_PATTERNS>) {
    for (const pattern of CATEGORY_PATTERNS[cat].keywords) {
      if (pattern.test(text)) {
        reactionScore += 1;
        categories[cat] += 1;
        break; // max 1 keyword match per category per message
      }
    }
  }

  // --- ALL CAPS detection (excitement indicator, min 5 chars) ---
  if (text.length >= 5 && text === text.toUpperCase() && /[A-Z]/.test(text)) {
    reactionScore += 0.5;
    categories.hype += 0.5;
  }

  // --- Repeated character spam detection (e.g. "AAAAAA", "GGGGGG") ---
  if (/(.)\1{5,}/i.test(text)) {
    reactionScore += 0.5;
    categories.hype += 0.3;
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
  /** Larger sample of ALL messages (scored or not) for spam detection */
  spamSampleMessages: string[];
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
        categoryScores: { fun: 0, hype: 0, shock: 0, love: 0, toxic: 0 },
        messageTimestamps: [],
        sampleMessages: [],
        spamSampleMessages: [],
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
    bucket.categoryScores.shock += categories.shock;
    bucket.categoryScores.love += categories.love;
    bucket.categoryScores.toxic += categories.toxic;

    // Keep a few sample reaction messages for context
    if (reactionScore > 0 && bucket.sampleMessages.length < 5) {
      bucket.sampleMessages.push(msg.text.slice(0, 80));
    }

    // Keep a larger sample of ALL messages for spam detection
    if (bucket.spamSampleMessages.length < 30) {
      bucket.spamSampleMessages.push(msg.text.slice(0, 80));
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
 * Detects copy-paste spam using the larger spamSampleMessages pool.
 * Returns a spam score (0 = no spam).
 */
function computeSpamScore(bucket: ChatBucket): number {
  const msgs = bucket.spamSampleMessages;
  if (msgs.length < 5) return 0;

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
 * category scores, burst intensity, and spam detection.
 */
function resolveDominantTag(
  bucket: ChatBucket,
  burstScore: number,
  spamScore: number
): HighlightTag {
  const cat = bucket.categoryScores;

  // If spam score is dominant, tag as spam
  if (spamScore > 0 && spamScore >= Math.max(cat.fun, cat.hype, cat.shock, cat.love, cat.toxic)) {
    return "spam";
  }

  // If burst is very high but no dominant category, it's spam-like flooding
  if (
    burstScore > 20 &&
    Math.max(cat.fun, cat.hype, cat.shock, cat.love, cat.toxic) < burstScore * 0.3
  ) {
    return "spam";
  }

  // Find highest category
  const entries: Array<[Exclude<HighlightTag, "spam">, number]> = [
    ["fun", cat.fun],
    ["hype", cat.hype],
    ["shock", cat.shock],
    ["love", cat.love],
    ["toxic", cat.toxic],
  ];
  entries.sort((a, b) => b[1] - a[1]);

  // Default to hype if nothing scored
  if (entries[0][1] === 0) return "hype";

  return entries[0][0];
}

/* ------------------------------------------------------------------ */
/*  Normalization helpers                                               */
/* ------------------------------------------------------------------ */

/** Compute the median of a numeric array. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
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

/**
 * Finds the top hype moments from the bucketed chat data.
 *
 * Uses a sliding window (summing adjacent buckets) then greedily
 * picks non-overlapping peaks. Each moment is tagged with its
 * dominant highlight category.
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

  // --- Chat speed normalization ---
  // Normalize messageCount relative to the VOD's median bucket activity.
  // This makes a 3x spike equally significant whether the channel has 500 or 50k viewers.
  const messageCounts = keys.map((k) => buckets.get(k)!.messageCount);
  const medianCount = median(messageCounts);

  // --- Velocity detection ---
  // Compute a rolling baseline (~5 min lookback) for each bucket,
  // then measure how much the current bucket spikes above baseline.
  const baselineWindow = 10; // 10 buckets = 5 minutes at 30s/bucket
  const bucketBaselines = new Map<number, number>();
  for (let i = 0; i < keys.length; i++) {
    const start = Math.max(0, i - baselineWindow);
    const end = i; // exclude current bucket from its own baseline
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += buckets.get(keys[j])!.messageCount;
      count++;
    }
    bucketBaselines.set(keys[i], count > 0 ? sum / count : 0);
  }

  // --- Score each bucket with normalization, velocity, and burst ---
  const scored: Array<{
    key: number;
    score: number;
    bucket: ChatBucket;
    burstScore: number;
    spamScore: number;
  }> = keys.map((key) => {
    const b = buckets.get(key)!;
    const burst = computeBurstScore(b);
    const spam = computeSpamScore(b);

    // Normalized message count (relative to VOD median)
    const normalizedCount = b.messageCount / Math.max(medianCount, 1);

    // Velocity: how much this bucket spikes above its local baseline
    const baseline = bucketBaselines.get(key) ?? 0;
    const velocity = baseline > 0
      ? (b.messageCount - baseline) / baseline
      : (b.messageCount > 5 ? 2 : 0); // small bonus for early activity

    // Composite score:
    //  normalizedCount*2 : volume relative to VOD average
    //  reactionScore*3   : keyword + emote matches (strongest quality signal)
    //  burst*1.0         : message flooding intensity
    //  velocity*5        : sudden activity spike (key for highlight detection)
    const score =
      normalizedCount * 2 +
      b.reactionScore * 3 +
      burst * 1.0 +
      Math.max(0, velocity) * 5;

    return { key, score, bucket: b, burstScore: burst, spamScore: spam };
  });

  // --- Multi-bucket sliding window ---
  // Boost each bucket by 30% of its best adjacent neighbor's score.
  // This catches highlights that straddle 30-second bucket boundaries.
  const scoreMap = new Map<number, number>();
  for (const entry of scored) {
    scoreMap.set(entry.key, entry.score);
  }
  for (const entry of scored) {
    const prevScore = scoreMap.get(entry.key - windowSec) ?? 0;
    const nextScore = scoreMap.get(entry.key + windowSec) ?? 0;
    const bestNeighbor = Math.max(prevScore, nextScore);
    entry.score += bestNeighbor * 0.3;
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Greedily pick non-overlapping peaks
  const selected: HypeMoment[] = [];
  const usedRanges: Array<[number, number]> = [];

  for (const entry of scored) {
    if (selected.length >= topN) break;

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

    const b = entry.bucket;
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
