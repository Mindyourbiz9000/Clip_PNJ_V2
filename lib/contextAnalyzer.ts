/**
 * Free, rule-based "context" analysis of one highlight (no AI):
 *  - the 10 chat messages before and after the reaction peak,
 *  - a title made from the phrase chat repeats the most,
 *  - a verdict: does this look like a reaction to the STREAM
 *    (many people reacting at once) or a conversation INSIDE the chat?
 *
 * Reasons are returned as codes + numbers so the page can translate them.
 */

import type { ChatMessage } from "./twitchChat";
import type { KeywordMatcher } from "./keywords";

export interface ContextMessage {
  offsetSeconds: number;
  author: string;
  text: string;
  /** True for the message closest to the reaction peak */
  isPeak?: boolean;
}

export type VerdictLevel = "strong" | "likely" | "doubtful";

export type ReasonCode =
  | "spike"            // chat suddenly sped up
  | "noSpike"          // no real acceleration
  | "manyPeople"       // many different chatters
  | "fewPeople"        // always the same few chatters
  | "reactions"        // most messages are reactions (keywords)
  | "fewReactions"     // few reactions
  | "shortMessages"    // short, instant messages
  | "conversation"     // lots of @replies between chatters
  | "sameTarget"       // many people @ the same person (often the streamer)
  | "repeatedPhrase";  // several people write the same thing

export interface Reason {
  code: ReasonCode;
  positive: boolean;
  /** Numbers to insert in the translated sentence */
  values: Record<string, number | string>;
}

export interface ContextResult {
  peakSec: number;
  before: ContextMessage[];
  peak: ContextMessage | null;
  after: ContextMessage[];
  /** Phrase chat repeats the most (null if none stands out) */
  phrase: string | null;
  /** How many different people wrote that phrase */
  phraseAuthors: number;
  score: number; // 0..100
  verdict: VerdictLevel;
  reasons: Reason[];
  stats: {
    messages: number;
    authors: number;
    perSecNow: number;
    perSecBefore: number;
  };
}

/** Very common words that never make a good title (FR + EN). */
const STOPWORDS = new Set(
  (
    "le la les un une des de du d l et ou mais donc or ni car a à au aux en dans sur sous pour par avec sans ce cet cette ces " +
    "c ça ca est es suis sont était etait été ete être etre ai as avons avez ont avait il elle on nous vous ils elles je j tu t me m te " +
    "se s y lui leur leurs son sa ses mon ma mes ton ta tes notre votre qui que quoi qu dont où ou ne pas plus moins très tres trop " +
    "bien tout tous toute toutes rien oui non si alors comme aussi fait faire va vas vont peut peux là la ici quand " +
    "the a an and or but of to in on at for with without is are was were be been am i you he she it we they me him her us them " +
    "my your his its our their this that these those what who how why when where not no yes so just like get got do does did " +
    "have has had will would can could should im its dont thats lol gg ok okay oh ah eh hein bah ben euh mdr ptdr xd"
  ).split(/\s+/)
);

const WORD_RE = /[\p{L}\p{N}']+/gu;

function words(text: string): string[] {
  return (text.toLowerCase().match(WORD_RE) ?? []).map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean);
}

/**
 * Finds the 1-3 word phrase written by the most DIFFERENT people,
 * ignoring reaction keywords, emotes, @mentions and filler words.
 */
function findRepeatedPhrase(
  messages: ChatMessage[],
  matcher: KeywordMatcher
): { phrase: string | null; authors: number } {
  const byPhrase = new Map<string, Set<string>>();

  for (const msg of messages) {
    const cleaned = msg.text
      .replace(/@\S+/g, " ")
      .replace(/https?:\/\/\S+/g, " ");
    // Drop emote fragments (native Twitch emotes)
    const emoteTexts = new Set(msg.fragments.filter((f) => f.emote).map((f) => f.text.trim().toLowerCase()));
    const m = matcher.match(msg.text);
    const kws = [...m.fun, ...m.hype, ...m.donation].map((k) => k.toLowerCase());
    const ws = words(cleaned).filter(
      (w) => !emoteTexts.has(w) && !matcher.isKeyword(w) && !kws.some((k) => w.startsWith(k))
    );

    const seen = new Set<string>();
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= ws.length; i++) {
        const gram = ws.slice(i, i + n);
        // A phrase must not start/end with a filler word, and needs a real word
        // Must end on a real word; may start with a small word only in
        // 3-word phrases ("il est tombé"), and needs at least one real word
        if (STOPWORDS.has(gram[gram.length - 1])) continue;
        if (n < 3 && STOPWORDS.has(gram[0])) continue;
        if (n === 1 && (gram[0].length < 4 || /^\d+$/.test(gram[0]))) continue;
        const key = gram.join(" ");
        if (seen.has(key)) continue;
        seen.add(key);
        if (!byPhrase.has(key)) byPhrase.set(key, new Set());
        byPhrase.get(key)!.add(msg.author || `anon-${msg.offsetSeconds}`);
      }
    }
  }

  let best: string | null = null;
  let bestScore = 0;
  let bestAuthors = 0;
  for (const [phrase, authors] of byPhrase) {
    if (authors.size < 2) continue;
    const n = phrase.split(" ").length;
    const score = authors.size * (1 + 0.35 * (n - 1)); // longer phrases are more telling
    if (score > bestScore) {
      best = phrase;
      bestScore = score;
      bestAuthors = authors.size;
    }
  }
  return { phrase: best, authors: bestAuthors };
}

export function analyzeContext(
  allMessages: ChatMessage[],
  peakSec: number,
  matcher: KeywordMatcher
): ContextResult {
  const msgs = [...allMessages].sort((a, b) => a.offsetSeconds - b.offsetSeconds);

  // ── 10 before / peak / 10 after ──
  let peakIdx = -1;
  let bestDist = Infinity;
  msgs.forEach((m, i) => {
    const d = Math.abs(m.offsetSeconds - peakSec);
    if (d < bestDist) {
      bestDist = d;
      peakIdx = i;
    }
  });
  const toCtx = (m: ChatMessage): ContextMessage => ({
    offsetSeconds: m.offsetSeconds,
    author: m.author,
    text: m.text.slice(0, 300),
  });
  const before = peakIdx > 0 ? msgs.slice(Math.max(0, peakIdx - 10), peakIdx).map(toCtx) : [];
  const peak = peakIdx >= 0 ? { ...toCtx(msgs[peakIdx]), isPeak: true } : null;
  const after = peakIdx >= 0 ? msgs.slice(peakIdx + 1, peakIdx + 11).map(toCtx) : [];

  // ── Statistics around the peak ──
  const now = msgs.filter((m) => m.offsetSeconds >= peakSec - 10 && m.offsetSeconds <= peakSec + 10);
  const baseline = msgs.filter((m) => m.offsetSeconds >= peakSec - 60 && m.offsetSeconds < peakSec - 20);
  const perSecNow = now.length / 20;
  const perSecBefore = baseline.length / 40;
  const spikeRatio = perSecNow / Math.max(perSecBefore, 0.05);

  const authors = new Set(now.map((m) => m.author));
  const authorRatio = now.length ? authors.size / now.length : 0;

  const reactionCount = now.filter((m) => {
    const r = matcher.match(m.text);
    return r.fun.length + r.hype.length + r.donation.length > 0;
  }).length;
  const reactionRatio = now.length ? reactionCount / now.length : 0;

  const shortRatio = now.length ? now.filter((m) => m.text.length <= 25).length / now.length : 0;

  // @mentions: spread over many people = conversation between chatters;
  // many people @ the same name = they react to that person (often the streamer)
  const mentionTargets = new Map<string, Set<string>>();
  let mentionMsgs = 0;
  for (const m of now) {
    const targets = m.text.match(/@([\w]+)/g);
    if (!targets) continue;
    mentionMsgs++;
    for (const t of targets) {
      const key = t.slice(1).toLowerCase();
      if (!mentionTargets.has(key)) mentionTargets.set(key, new Set());
      mentionTargets.get(key)!.add(m.author);
    }
  }
  let topTarget = "";
  let topTargetAuthors = 0;
  for (const [t, a] of mentionTargets) {
    if (a.size > topTargetAuthors) {
      topTarget = t;
      topTargetAuthors = a.size;
    }
  }
  const mentionRatio = now.length ? mentionMsgs / now.length : 0;
  const sameTarget = topTargetAuthors >= 3;

  const { phrase, authors: phraseAuthors } = findRepeatedPhrase(
    msgs.filter((m) => m.offsetSeconds >= peakSec - 15 && m.offsetSeconds <= peakSec + 20),
    matcher
  );

  // ── Score ──
  let score = 50;
  const reasons: Reason[] = [];
  const pct = (x: number) => Math.round(x * 100);
  const r1 = (x: number) => Math.round(x * 10) / 10;

  if (spikeRatio >= 2) {
    score += Math.min(20, Math.round((spikeRatio - 1) * 6));
    reasons.push({ code: "spike", positive: true, values: { ratio: r1(spikeRatio), before: r1(perSecBefore), now: r1(perSecNow) } });
  } else {
    score -= 10;
    reasons.push({ code: "noSpike", positive: false, values: { ratio: r1(spikeRatio) } });
  }

  if (authors.size >= 8 && authorRatio >= 0.5) {
    score += 15;
    reasons.push({ code: "manyPeople", positive: true, values: { n: authors.size } });
  } else if (authors.size < 5 || authorRatio < 0.35) {
    score -= 15;
    reasons.push({ code: "fewPeople", positive: false, values: { n: authors.size, msgs: now.length } });
  }

  if (reactionRatio >= 0.3) {
    score += 10;
    reasons.push({ code: "reactions", positive: true, values: { pct: pct(reactionRatio) } });
  } else if (reactionRatio < 0.1) {
    score -= 5;
    reasons.push({ code: "fewReactions", positive: false, values: { pct: pct(reactionRatio) } });
  }

  if (shortRatio >= 0.6) {
    score += 5;
    reasons.push({ code: "shortMessages", positive: true, values: { pct: pct(shortRatio) } });
  }

  if (sameTarget) {
    score += 5;
    reasons.push({ code: "sameTarget", positive: true, values: { name: topTarget, n: topTargetAuthors } });
  } else if (mentionRatio >= 0.3) {
    score -= 20;
    reasons.push({ code: "conversation", positive: false, values: { pct: pct(mentionRatio) } });
  }

  if (phrase && phraseAuthors >= 3) {
    score += 5;
    reasons.push({ code: "repeatedPhrase", positive: true, values: { phrase, n: phraseAuthors } });
  }

  score = Math.max(0, Math.min(100, score));
  const verdict: VerdictLevel = score >= 65 ? "strong" : score >= 40 ? "likely" : "doubtful";

  return {
    peakSec,
    before,
    peak,
    after,
    phrase,
    phraseAuthors,
    score,
    verdict,
    reasons,
    stats: { messages: now.length, authors: authors.size, perSecNow: r1(perSecNow), perSecBefore: r1(perSecBefore) },
  };
}
