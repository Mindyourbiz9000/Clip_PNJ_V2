/**
 * Detection keywords, shared by the page (editing, saved in the browser)
 * and the server (chat analysis). No database: the page sends its list
 * with each analysis request.
 *
 * Matching rules (simple on purpose, so anyone can edit the list):
 *  - case-insensitive;
 *  - a keyword also matches its stretched forms: "mdr" matches "mdrrrr",
 *    "haha" matches "hahahaha", "lmao" matches "lmaooo", "cheer" matches
 *    "cheer100" (extra letters must repeat the keyword's last letters);
 *  - a keyword can be several words ("je suis mort");
 *  - emojis and symbols match anywhere in the message.
 *
 * Bans ("has been banned") and big sub gifts ("is gifting N", N >= 15) are
 * Twitch system messages: they are always detected and are not editable.
 */

export type KeywordCategory = "fun" | "hype" | "donation";
export type KeywordConfig = Record<KeywordCategory, string[]>;

export const KEYWORD_CATEGORIES: KeywordCategory[] = ["fun", "hype", "donation"];

export const KEYWORD_LIMITS = { perCategory: 300, maxLength: 40 };

export const DEFAULT_KEYWORDS: KeywordConfig = {
  fun: [
    // Emotes (native + 7TV / BTTV / FFZ, which arrive as plain text)
    "KEKW", "KEKWait", "KEKL", "OMEGALUL", "LULW", "LUL", "ICANT", "xdd", "pepeLaugh",
    "peepoLaugh", "EleGiggle", "4Head", "WAJAJA", "LOLW", "forsenLaughingAtYou",
    "DIESOFCRINGE", "aRolf", "monkaLaugh",
    // French
    "mdr", "ptdr", "xptdr", "jpp", "mort de rire", "je suis mort", "jsuis mort",
    "j'suis mort", "trop drôle", "trop drole",
    // English
    "lmao", "lmfao", "rofl", "im dead", "i'm dead",
    // Typed laughter
    "haha", "ahah", "hehehe", "xd",
    // Emojis
    "😂", "🤣", "💀", "😭", "☠️", "😹",
  ],
  hype: [
    "PogChamp", "Pog", "PogU", "POGGIES", "POGCRAZY", "Kreygasm", "HYPERS", "monkaS",
    "monkaW", "WutFace", "lets go", "let's go", "letsgo", "clip it", "clip that",
    "insane", "omg", "wtf", "holy shit", "no way", "🔥", "😱",
  ],
  donation: [
    "cheer", "bits", "dono", "donate", "donation", "HypeCheer",
    "💰", "💵", "💸", "🤑", "💎", "🎁",
  ],
};

/** Cleans a keyword list received from the client (never trust input). */
export function sanitizeKeywords(input: unknown): KeywordConfig {
  const out = {} as KeywordConfig;
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  for (const cat of KEYWORD_CATEGORIES) {
    const raw = obj[cat];
    if (!Array.isArray(raw)) {
      out[cat] = [...DEFAULT_KEYWORDS[cat]];
      continue;
    }
    const seen = new Set<string>();
    const list: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string") continue;
      const kw = item.trim().replace(/\s+/g, " ").slice(0, KEYWORD_LIMITS.maxLength);
      if (!kw || seen.has(kw.toLowerCase())) continue;
      seen.add(kw.toLowerCase());
      list.push(kw);
      if (list.length >= KEYWORD_LIMITS.perCategory) break;
    }
    out[cat] = list;
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if the keyword starts with a letter or digit (word keyword). */
function isWordKeyword(kw: string): boolean {
  return /^[\p{L}\p{N}]/u.test(kw);
}

/**
 * True if `tail` (letters right after the keyword) only stretches it:
 * empty, digits, or repeats of the keyword's last two letters.
 */
function isStretch(keyword: string, tail: string): boolean {
  if (!tail) return true;
  const allowed = new Set(keyword.replace(/\s+/g, "").slice(-2).split(""));
  for (const ch of tail.toLowerCase()) {
    if (/\p{N}/u.test(ch)) continue;
    if (!allowed.has(ch)) return false;
  }
  return true;
}

export type KeywordMatches = Record<KeywordCategory, string[]>;

/** Finds which keywords of each category appear in a chat message. */
export class KeywordMatcher {
  private wordRegex: Partial<Record<KeywordCategory, RegExp>> = {};
  private canonical: Partial<Record<KeywordCategory, Map<string, string>>> = {};
  private symbols: Partial<Record<KeywordCategory, string[]>> = {};
  private allLower = new Set<string>();

  constructor(config: KeywordConfig) {
    for (const cat of KEYWORD_CATEGORIES) {
      const words = config[cat].filter(isWordKeyword);
      const map = new Map<string, string>();
      for (const w of words) {
        map.set(w.toLowerCase(), w);
        this.allLower.add(w.toLowerCase());
      }
      this.canonical[cat] = map;
      this.symbols[cat] = config[cat].filter((k) => !isWordKeyword(k));
      if (words.length > 0) {
        // Longest first, so "OMEGALUL" wins over "LUL"
        const alts = [...words]
          .sort((a, b) => b.length - a.length)
          .map((w) => escapeRegExp(w).replace(/ /g, "\\s+"));
        this.wordRegex[cat] = new RegExp(
          `(?:^|[^\\p{L}\\p{N}_])(${alts.join("|")})([\\p{L}\\p{N}]*)`,
          "giu"
        );
      }
    }
  }

  /** True if this exact text is one of the word keywords (any category). */
  isKeyword(text: string): boolean {
    return this.allLower.has(text.trim().toLowerCase());
  }

  match(text: string): KeywordMatches {
    const res: KeywordMatches = { fun: [], hype: [], donation: [] };
    for (const cat of KEYWORD_CATEGORIES) {
      const re = this.wordRegex[cat];
      if (re) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const found = m[1].toLowerCase().replace(/\s+/g, " ");
          if (!isStretch(found, m[2])) continue; // "Lulu" is not "LUL"
          res[cat].push(this.canonical[cat]!.get(found) ?? m[1]);
          if (res[cat].length >= 10) break;
        }
      }
      for (const sym of this.symbols[cat]!) {
        let idx = text.indexOf(sym);
        let n = 0;
        while (idx !== -1 && n < 3) {
          res[cat].push(sym);
          n++;
          idx = text.indexOf(sym, idx + sym.length);
        }
      }
    }
    return res;
  }
}
