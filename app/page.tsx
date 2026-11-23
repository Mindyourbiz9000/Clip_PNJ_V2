"use client";

import { useState, useEffect, useRef } from "react";
import { I18nProvider, LanguageSwitch, rich, useI18n } from "@/lib/i18n";
import {
  DEFAULT_KEYWORDS,
  KEYWORD_CATEGORIES,
  KEYWORD_LIMITS,
  sanitizeKeywords,
  type KeywordCategory,
  type KeywordConfig,
} from "@/lib/keywords";

/** Browser storage key for the user's keywords (no database). */
const KEYWORDS_STORAGE_KEY = "clipping.keywords.v1";

type AnalyzeStatus = "idle" | "analyzing" | "done" | "error";

type HighlightTag = "fun" | "hype" | "ban" | "sub" | "donation";

interface HypeMoment {
  startSec: number;
  endSec: number;
  score: number;
  messagesPerSec: number;
  messageCount: number;
  tag: HighlightTag;
  categoryScores: Record<string, number>;
  burstScore: number;
  sampleMessages: string[];
  keywords?: Array<{ category: KeywordCategory; word: string; count: number }>;
}

/** Visual config for each highlight tag */
const TAG_CONFIG: Record<HighlightTag, { label: string; emoji: string; color: string; bg: string; border: string; gradient: string }> = {
  fun:      { label: "Fun",      emoji: "😂", color: "text-yellow-300",  bg: "bg-yellow-500/15",  border: "border-yellow-500/40",  gradient: "from-yellow-500 to-amber-500" },
  hype:     { label: "Hype",     emoji: "🔥", color: "text-orange-300",  bg: "bg-orange-500/15",  border: "border-orange-500/40",  gradient: "from-orange-500 to-red-500" },
  ban:      { label: "Ban",      emoji: "🔨", color: "text-red-300",     bg: "bg-red-500/15",     border: "border-red-500/40",     gradient: "from-red-500 to-rose-600" },
  sub:      { label: "Sub",      emoji: "⭐", color: "text-purple-300",  bg: "bg-purple-500/15",  border: "border-purple-500/40",  gradient: "from-purple-500 to-violet-500" },
  donation: { label: "Donation", emoji: "💰", color: "text-emerald-300", bg: "bg-emerald-500/15", border: "border-emerald-500/40", gradient: "from-emerald-500 to-green-500" },
};

interface ChatMsg {
  offsetSeconds: number;
  author: string;
  text: string;
  fragments: { text: string; emote: { emoteID: string } | null }[];
}

function formatTime(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [
    h.toString().padStart(2, "0"),
    m.toString().padStart(2, "0"),
    s.toString().padStart(2, "0"),
  ].join(":");
}

function formatChatTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function isTwitchVodUrl(url: string): boolean {
  return /^https?:\/\/(?:www\.)?twitch\.tv\/videos\/\d+/.test(url);
}

function extractVideoId(url: string): string | null {
  const match = url.match(/twitch\.tv\/videos\/(\d+)/);
  return match ? match[1] : null;
}

/* ------------------------------------------------------------------ */
/*  Twitch Player Component                                           */
/* ------------------------------------------------------------------ */

function TwitchPlayer({
  videoId,
  onTimeUpdate,
  playerRef,
}: {
  videoId: string;
  onTimeUpdate?: (time: number) => void;
  playerRef: React.MutableRefObject<any>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    if (!videoId || !containerRef.current) return;

    // Clear previous player content
    containerRef.current.innerHTML = "";

    function initPlayer() {
      if (!containerRef.current) return;
      const Twitch = (window as any).Twitch;
      if (!Twitch?.Player) return;

      const player = new Twitch.Player(containerRef.current, {
        video: videoId,
        parent: [window.location.hostname],
        autoplay: false,
        width: "100%",
        height: "100%",
      });

      playerRef.current = player;

      // Poll current time for chat sync
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(() => {
        try {
          const t = player.getCurrentTime();
          if (typeof t === "number" && onTimeUpdate) {
            onTimeUpdate(t);
          }
        } catch {
          // Player may not be ready yet
        }
      }, 1000);
    }

    // Load Twitch embed script if not already loaded
    if ((window as any).Twitch?.Player) {
      initPlayer();
    } else {
      const script = document.createElement("script");
      script.src = "https://player.twitch.tv/js/embed/v1.js";
      script.async = true;
      script.onload = initPlayer;
      document.body.appendChild(script);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      playerRef.current = null;
    };
  }, [videoId]);

  return (
    <div
      ref={containerRef}
      className="aspect-video w-full overflow-hidden rounded-lg bg-black"
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Chat Replay Panel (live-page-chat style)                          */
/* ------------------------------------------------------------------ */

interface SearchHit {
  offsetSeconds: number;
  text: string;
}

function ChatReplayPanel({
  url,
  currentTime,
  onSeek,
}: {
  url: string;
  currentTime: number;
  onSeek?: (seconds: number) => void;
}) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const fetchingRef = useRef(false);

  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Show messages up to current time + small buffer
  const visibleMessages = messages.filter((m) => m.offsetSeconds <= currentTime + 2);

  // Fetch initial chat batch when URL loads
  useEffect(() => {
    if (!url || !isTwitchVodUrl(url)) return;
    setMessages([]);
    setNextCursor(null);
    setError("");
    fetchChat(0);
  }, [url]);

  // Auto-fetch more messages as video progresses
  useEffect(() => {
    if (!url || messages.length === 0 || fetchingRef.current) return;
    const lastMsg = messages[messages.length - 1];
    // If current time is within 30s of last fetched message, load more
    if (lastMsg && currentTime > lastMsg.offsetSeconds - 30 && nextCursor) {
      fetchMoreChat();
    }
  }, [currentTime]);

  // Auto-scroll: keep the chat scrolled to the bottom as new messages appear.
  // IMPORTANT: We scroll the container directly instead of using
  // scrollIntoView, because scrollIntoView also scrolls the *window*,
  // which causes the page to jump down after the user clicks a highlight
  // and the page has just scrolled up to the video.
  useEffect(() => {
    if (!autoScroll || !containerRef.current) return;
    containerRef.current.scrollTo({
      top: containerRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [visibleMessages.length, autoScroll]);

  async function fetchChat(offset: number, cursor?: string) {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setLoading(true);
    try {
      const params = new URLSearchParams({ url, offset: offset.toString() });
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`/api/chat?${params}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: t.failedLoadChat }));
        throw new Error(data.error);
      }
      const data = await res.json();
      setMessages((prev) => {
        const existing = new Set(prev.map((m: ChatMsg) => `${m.offsetSeconds}:${m.text}`));
        const newMsgs = (data.messages as ChatMsg[]).filter(
          (m) => !existing.has(`${m.offsetSeconds}:${m.text}`)
        );
        return [...prev, ...newMsgs];
      });
      setNextCursor(data.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.failedLoadChat);
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }

  function fetchMoreChat() {
    if (nextCursor) {
      fetchChat(0, nextCursor);
    }
  }

  function handleScroll() {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 80;
    setAutoScroll(isNearBottom);
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = searchQuery.trim();
    if (q.length < 2) return;

    setSearching(true);
    setSearchError("");
    setSearchResults([]);

    try {
      const params = new URLSearchParams({ url, q });
      const res = await fetch(`/api/chat/search?${params}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: t.searchFailed }));
        throw new Error(data.error);
      }
      const data = await res.json();
      setSearchResults(data.hits ?? []);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : t.searchFailed);
    } finally {
      setSearching(false);
    }
  }

  function jumpToTime(seconds: number) {
    if (onSeek) {
      onSeek(seconds);
    }
    setSearchOpen(false);
  }

  return (
    <div className="flex h-full flex-col rounded-lg border border-gray-700 bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-700 px-3 py-2">
        <span className="text-sm font-semibold text-gray-300">{t.chatReplay}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">
            {visibleMessages.length} / {messages.length} {t.msgs}
          </span>
          <button
            onClick={() => {
              setSearchOpen((prev) => !prev);
              if (!searchOpen) {
                setTimeout(() => searchInputRef.current?.focus(), 50);
              }
            }}
            title={t.searchChat}
            className="rounded p-1 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Search panel */}
      {searchOpen && (
        <div className="border-b border-gray-700 bg-gray-800/60 px-3 py-2 space-y-2">
          <form onSubmit={handleSearch} className="flex gap-2">
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t.searchPlaceholder}
              className="flex-1 rounded border border-gray-600 bg-gray-900 px-2.5 py-1.5 text-xs text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              type="submit"
              disabled={searching || searchQuery.trim().length < 2}
              className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {searching ? "..." : t.search}
            </button>
          </form>

          {/* Search results */}
          {searching && (
            <div className="flex items-center gap-1.5 text-xs text-gray-400">
              <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {t.scanningFullChat}
            </div>
          )}

          {searchError && <p className="text-xs text-red-400">{searchError}</p>}

          {!searching && searchResults.length > 0 && (
            <div className="max-h-48 overflow-y-auto space-y-0.5">
              <p className="text-xs text-gray-500 mb-1">
                {t.resultsFound(searchResults.length)}
              </p>
              {searchResults.map((hit, i) => (
                <button
                  key={`${hit.offsetSeconds}-${i}`}
                  onClick={() => jumpToTime(hit.offsetSeconds)}
                  className="flex w-full items-start gap-2 rounded px-2 py-1 text-left text-xs hover:bg-gray-700 transition"
                >
                  <span className="shrink-0 font-mono text-indigo-400">
                    {formatChatTime(hit.offsetSeconds)}
                  </span>
                  <span className="text-gray-300 truncate">{hit.text}</span>
                </button>
              ))}
            </div>
          )}

          {!searching && !searchError && searchResults.length === 0 && searchQuery.trim().length >= 2 && (
            <p className="text-xs text-gray-500">{t.noResults}</p>
          )}
        </div>
      )}

      {/* Messages */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-2 space-y-0.5"
        style={{ minHeight: 0 }}
      >
        {error && <p className="text-xs text-red-400 py-2">{error}</p>}
        {visibleMessages.length === 0 && !loading && !error && (
          <p className="text-xs text-gray-500 py-4 text-center">
            {t.chatWillAppear}
          </p>
        )}
        {visibleMessages.map((msg, i) => (
          <div
            key={`${msg.offsetSeconds}-${i}`}
            data-offset={msg.offsetSeconds}
            className="py-0.5 text-sm leading-snug"
          >
            <span className="text-gray-500 text-xs mr-1.5">
              {formatChatTime(msg.offsetSeconds)}
            </span>
            {msg.author && (
              <span className="font-semibold text-purple-400 mr-1">
                {msg.author}:
              </span>
            )}
            {msg.fragments.map((frag, fi) =>
              frag.emote ? (
                <span key={fi} className="text-purple-400" title={frag.text}>
                  {frag.text}
                </span>
              ) : (
                <span key={fi} className="text-gray-300">
                  {frag.text}
                </span>
              )
            )}
          </div>
        ))}
        {loading && (
          <div className="flex items-center gap-1.5 py-2 text-xs text-gray-500">
            <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {t.loadingChat}
          </div>
        )}
      </div>

      {/* Auto-scroll resume button */}
      {!autoScroll && visibleMessages.length > 0 && (
        <button
          onClick={() => {
            setAutoScroll(true);
            if (containerRef.current) {
              containerRef.current.scrollTo({
                top: containerRef.current.scrollHeight,
                behavior: "smooth",
              });
            }
          }}
          className="border-t border-gray-700 px-3 py-1.5 text-xs text-purple-400 hover:bg-gray-800 transition"
        >
          {t.resumeAutoScroll}
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Highlight Scan Counter                                             */
/* ------------------------------------------------------------------ */

function HighlightScanCounter({ value }: { value: number }) {
  const { t } = useI18n();
  const digits = String(value).padStart(5, "0").split("");

  return (
    <div className="flex flex-col items-center gap-2">
      {/* Digit display */}
      <div className="flex gap-1">
        {digits.map((digit, i) => (
          <div
            key={i}
            className="flex h-10 w-8 items-center justify-center overflow-hidden rounded-md border border-gray-700 bg-gray-800 shadow-inner"
          >
            <span
              key={`${i}-${digit}-${value}`}
              className="counter-digit-roll select-none text-lg font-bold tabular-nums text-purple-300"
            >
              {digit}
            </span>
          </div>
        ))}
      </div>
      {/* Label */}
      <span className="text-xs font-medium tracking-wide text-gray-500">
        {t.scansPerformed}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Chat Activity Chart (SVG)                                          */
/* ------------------------------------------------------------------ */

interface TimelinePoint {
  sec: number;
  count: number;
}

/* ------------------------------------------------------------------ */
/*  Keyword editor (saved in the browser only)                         */
/* ------------------------------------------------------------------ */

function sameList(a: string[], b: string[]) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function KeywordEditor({
  keywords,
  onChange,
}: {
  keywords: KeywordConfig;
  onChange: (next: KeywordConfig) => void;
}) {
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<Record<KeywordCategory, string>>({ fun: "", hype: "", donation: "" });
  const modified = KEYWORD_CATEGORIES.some((c) => !sameList(keywords[c], DEFAULT_KEYWORDS[c]));

  function add(cat: KeywordCategory) {
    // Several keywords at once, separated by commas
    const parts = drafts[cat].split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const existing = new Set(keywords[cat].map((k) => k.toLowerCase()));
    const added = parts.filter((p) => !existing.has(p.toLowerCase()));
    onChange(sanitizeKeywords({ ...keywords, [cat]: [...keywords[cat], ...added] }));
    setDrafts((d) => ({ ...d, [cat]: "" }));
  }

  function remove(cat: KeywordCategory, word: string) {
    onChange({ ...keywords, [cat]: keywords[cat].filter((k) => k !== word) });
  }

  return (
    <details className="group mt-4 rounded-lg border border-gray-700 bg-gray-800/40">
      <summary className="flex cursor-pointer select-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-gray-200">
        <span>
          🔤 {t.kwTitle}
          {modified && (
            <span className="ml-2 rounded-full bg-indigo-500/20 px-2 py-0.5 text-[10px] font-semibold text-indigo-300">
              {t.kwCustomized}
            </span>
          )}
        </span>
        <span className="text-xs text-gray-500 group-open:hidden">{t.kwShow}</span>
        <span className="hidden text-xs text-gray-500 group-open:inline">{t.kwHide}</span>
      </summary>

      <div className="space-y-4 border-t border-gray-700 px-4 pb-4 pt-3">
        <p className="text-xs text-gray-400">{rich(t.kwIntro)}</p>

        {KEYWORD_CATEGORIES.map((cat) => {
          const cfg = TAG_CONFIG[cat];
          const isDefault = sameList(keywords[cat], DEFAULT_KEYWORDS[cat]);
          return (
            <div key={cat}>
              <div className="mb-1.5 flex items-center justify-between">
                <span className={`text-xs font-semibold ${cfg.color}`}>
                  {cfg.emoji} {t.tag[cat]}{" "}
                  <span className="font-normal text-gray-500">({keywords[cat].length})</span>
                </span>
                {!isDefault && (
                  <button
                    type="button"
                    onClick={() => onChange({ ...keywords, [cat]: [...DEFAULT_KEYWORDS[cat]] })}
                    className="text-[11px] text-gray-400 underline hover:text-gray-200"
                  >
                    {t.kwReset(t.tag[cat])}
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {keywords[cat].map((word) => (
                  <span
                    key={word}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${cfg.color} ${cfg.bg} ${cfg.border}`}
                  >
                    {word}
                    <button
                      type="button"
                      onClick={() => remove(cat, word)}
                      aria-label={t.kwRemove(word)}
                      className="opacity-60 hover:opacity-100"
                    >
                      &times;
                    </button>
                  </span>
                ))}
                {keywords[cat].length === 0 && (
                  <span className="text-xs italic text-gray-500">{t.kwEmpty}</span>
                )}
              </div>
              <form
                className="mt-2 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  add(cat);
                }}
              >
                <input
                  type="text"
                  value={drafts[cat]}
                  maxLength={KEYWORD_LIMITS.maxLength * 5}
                  onChange={(e) => setDrafts((d) => ({ ...d, [cat]: e.target.value }))}
                  placeholder={t.kwAddPlaceholder(t.tag[cat])}
                  className="min-w-0 flex-1 rounded-md border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
                />
                <button
                  type="submit"
                  className="rounded-md border border-gray-600 bg-gray-700 px-3 py-1.5 text-xs font-semibold text-gray-200 hover:bg-gray-600"
                >
                  {t.kwAdd}
                </button>
              </form>
            </div>
          );
        })}

        <div className="rounded-md bg-gray-900/60 px-3 py-2 text-[11px] text-gray-500">
          {t.kwAlways} {TAG_CONFIG.ban.emoji} {t.kwAlwaysBans} {t.kwAnd} {TAG_CONFIG.sub.emoji}{" "}
          {t.kwAlwaysSubs}.
        </div>

        {modified && (
          <button
            type="button"
            onClick={() => {
              if (window.confirm(t.kwConfirmResetAll)) onChange(sanitizeKeywords(DEFAULT_KEYWORDS));
            }}
            className="text-xs text-red-300 underline hover:text-red-200"
          >
            {t.kwResetAll}
          </button>
        )}
      </div>
    </details>
  );
}

function ChatActivityChart({
  timeline,
  moments,
  onSeek,
}: {
  timeline: TimelinePoint[];
  moments: HypeMoment[];
  onSeek?: (seconds: number) => void;
}) {
  const { t } = useI18n();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 200 });

  // Responsive: measure container width
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      if (width > 0) setDimensions({ width, height: 200 });
    });
    observer.observe(svg.parentElement!);
    return () => observer.disconnect();
  }, []);

  if (timeline.length === 0) return null;

  const { width, height } = dimensions;
  const padLeft = 45;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 28;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const maxSec = timeline[timeline.length - 1].sec;
  const minSec = timeline[0].sec;
  const timeRange = maxSec - minSec || 1;
  const maxCount = Math.max(...timeline.map((p) => p.count), 1);

  const x = (sec: number) => padLeft + ((sec - minSec) / timeRange) * chartW;
  const y = (count: number) => padTop + chartH - (count / maxCount) * chartH;

  // Build the area path
  const points = timeline.map((p) => `${x(p.sec)},${y(p.count)}`);
  const areaPath = `M${x(minSec)},${y(0)} L${points.join(" L")} L${x(timeline[timeline.length - 1].sec)},${y(0)} Z`;
  const linePath = `M${points.join(" L")}`;

  // Y axis ticks (4 ticks)
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((frac) => ({
    val: Math.round(maxCount * frac),
    y: padTop + chartH - frac * chartH,
  }));

  // X axis ticks (every ~15 minutes or so, adaptive)
  const totalMinutes = timeRange / 60;
  const tickInterval = totalMinutes <= 30 ? 5 : totalMinutes <= 120 ? 15 : totalMinutes <= 300 ? 30 : 60;
  const xTicks: Array<{ sec: number; label: string }> = [];
  const firstTick = Math.ceil(minSec / 60 / tickInterval) * tickInterval * 60;
  for (let s = firstTick; s <= maxSec; s += tickInterval * 60) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    xTicks.push({ sec: s, label: h > 0 ? `${h}:${m.toString().padStart(2, "0")}` : `${m}m` });
  }

  // Handle click on chart
  function handleClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!onSeek) return;
    const rect = svgRef.current!.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const sec = minSec + ((mouseX - padLeft) / chartW) * timeRange;
    if (sec >= minSec && sec <= maxSec) {
      onSeek(Math.round(sec));
    }
  }

  // Handle hover
  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current!.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const sec = minSec + ((mouseX - padLeft) / chartW) * timeRange;
    // Find closest timeline point
    let closest = 0;
    let closestDist = Infinity;
    for (let i = 0; i < timeline.length; i++) {
      const d = Math.abs(timeline[i].sec - sec);
      if (d < closestDist) {
        closestDist = d;
        closest = i;
      }
    }
    setHoveredIdx(closest);
  }

  const hovered = hoveredIdx !== null ? timeline[hoveredIdx] : null;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="cursor-crosshair"
        onClick={handleClick}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoveredIdx(null)}
      >
        {/* Grid lines */}
        {yTicks.map((t) => (
          <line key={t.val} x1={padLeft} x2={width - padRight} y1={t.y} y2={t.y} stroke="#374151" strokeWidth={0.5} />
        ))}

        {/* Highlight moment regions */}
        {moments.map((m, i) => {
          const x1 = Math.max(padLeft, x(m.startSec));
          const x2 = Math.min(width - padRight, x(m.endSec));
          if (x2 <= x1) return null;
          const tagCfg = TAG_CONFIG[m.tag] ?? TAG_CONFIG.hype;
          // Extract the base color for the fill
          const fillColor = m.tag === "fun" ? "rgba(234,179,8,0.15)"
            : m.tag === "hype" ? "rgba(249,115,22,0.15)"
            : m.tag === "ban" ? "rgba(239,68,68,0.15)"
            : m.tag === "sub" ? "rgba(168,85,247,0.15)"
            : "rgba(16,185,129,0.15)";
          return (
            <rect
              key={`hl-${i}`}
              x={x1}
              y={padTop}
              width={x2 - x1}
              height={chartH}
              fill={fillColor}
            />
          );
        })}

        {/* Area fill */}
        <path d={areaPath} fill="url(#areaGrad)" />
        {/* Line */}
        <path d={linePath} fill="none" stroke="#a78bfa" strokeWidth={1.5} />

        {/* Gradient definition */}
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#a78bfa" stopOpacity={0.02} />
          </linearGradient>
        </defs>

        {/* Y axis labels */}
        {yTicks.map((t) => (
          <text key={`yl-${t.val}`} x={padLeft - 6} y={t.y + 3} textAnchor="end" className="fill-gray-500" fontSize={10}>
            {t.val}
          </text>
        ))}

        {/* X axis labels */}
        {xTicks.map((t) => (
          <text key={`xl-${t.sec}`} x={x(t.sec)} y={height - 6} textAnchor="middle" className="fill-gray-500" fontSize={10}>
            {t.label}
          </text>
        ))}

        {/* Hover crosshair + tooltip */}
        {hovered && (
          <>
            <line x1={x(hovered.sec)} x2={x(hovered.sec)} y1={padTop} y2={padTop + chartH} stroke="#a78bfa" strokeWidth={1} strokeDasharray="3,3" opacity={0.6} />
            <circle cx={x(hovered.sec)} cy={y(hovered.count)} r={3.5} fill="#a78bfa" stroke="#1f2937" strokeWidth={1.5} />
          </>
        )}
      </svg>

      {/* Tooltip */}
      {hovered && (
        <div
          className="pointer-events-none absolute -top-1 rounded bg-gray-800 border border-gray-600 px-2 py-1 text-xs text-gray-200 shadow-lg"
          style={{
            left: `${Math.min(Math.max(x(hovered.sec), 60), width - 100)}px`,
            transform: "translateX(-50%)",
          }}
        >
          <span className="text-purple-300 font-mono">{formatTime(hovered.sec)}</span>
          {" "}&middot;{" "}
          <span className="font-semibold">{hovered.count}</span> {t.msgsPerMin}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function Home() {
  return (
    <I18nProvider>
      <HomeContent />
    </I18nProvider>
  );
}

function HomeContent() {
  const { t } = useI18n();
  const [url, setUrl] = useState("");

  // Chat analysis state
  const [analyzeStatus, setAnalyzeStatus] = useState<AnalyzeStatus>("idle");
  const [analyzeError, setAnalyzeError] = useState("");
  const [moments, setMoments] = useState<HypeMoment[]>([]);

  // Detection keywords: defaults, or the user's list saved in this browser
  const [keywords, setKeywords] = useState<KeywordConfig>(() => sanitizeKeywords(DEFAULT_KEYWORDS));
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(KEYWORDS_STORAGE_KEY);
      if (saved) setKeywords(sanitizeKeywords(JSON.parse(saved)));
    } catch {
      // Storage unavailable or corrupted: keep defaults
    }
  }, []);
  function updateKeywords(next: KeywordConfig) {
    setKeywords(next);
    try {
      window.localStorage.setItem(KEYWORDS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private mode / storage full: still works for this session
    }
  }
  const [totalMessages, setTotalMessages] = useState(0);
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const [selectedMomentIdx, setSelectedMomentIdx] = useState<number | null>(null);

  // Highlight detection counter (persisted on server)
  const [analyzeCount, setAnalyzeCount] = useState(0);
  useEffect(() => {
    fetch("/api/counter")
      .then((r) => r.json())
      .then((d) => setAnalyzeCount(d.count))
      .catch(() => {});
  }, []);

  // Video / chat sync state
  const [currentTime, setCurrentTime] = useState(0);
  const playerRef = useRef<any>(null);

  const isTwitch = isTwitchVodUrl(url);
  const videoId = isTwitch ? extractVideoId(url) : null;

  async function handleAnalyze() {
    setAnalyzeStatus("analyzing");
    setAnalyzeError("");
    setMoments([]);
    setTimeline([]);
    setSelectedMomentIdx(null);

    // Increment the global counter
    fetch("/api/counter", { method: "POST" })
      .then((r) => r.json())
      .then((d) => setAnalyzeCount(d.count))
      .catch(() => setAnalyzeCount((prev) => prev + 1));

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, keywords }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: t.unknownError }));
        throw new Error(data.error || t.serverError(res.status));
      }

      const data = await res.json();
      setMoments(data.moments ?? []);
      setTotalMessages(data.totalMessages ?? 0);
      setTimeline(data.timeline ?? []);
      setAnalyzeStatus("done");
    } catch (err) {
      setAnalyzeStatus("error");
      setAnalyzeError(err instanceof Error ? err.message : t.analysisFailed);
    }
  }

  function selectMoment(moment: HypeMoment, index: number, scrollToTop = true) {
    // Remove focus from the clicked button so the browser doesn't
    // try to keep the focused element visible.
    (document.activeElement as HTMLElement)?.blur();
    setSelectedMomentIdx(index);

    // Wait for React to finish re-rendering (the selected highlight
    // changes style) before scrolling, so the browser's layout-driven
    // scroll doesn't fight ours.
    if (scrollToTop) {
      requestAnimationFrame(() => {
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    }

    // Seek the embedded player to this moment
    if (playerRef.current) {
      try {
        playerRef.current.seek(moment.startSec);
        playerRef.current.play();
      } catch {
        // Player might not support seek yet
      }
    }
  }

  /** Jump to the previous / next highlight (from the one currently selected). */
  function stepMoment(delta: 1 | -1) {
    if (moments.length === 0) return;
    const next =
      selectedMomentIdx === null
        ? delta === 1 ? 0 : moments.length - 1
        : (selectedMomentIdx + delta + moments.length) % moments.length;
    selectMoment(moments[next], next, false); // stay where we are: the buttons are under the video
  }

  // Keyboard shortcuts: N = next highlight, P = previous (ignored while typing)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n" || e.key === "N") stepMoment(1);
      if (e.key === "p" || e.key === "P") stepMoment(-1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const maxScore = moments.length > 0 ? Math.max(...moments.map((m) => m.score)) : 1;

  return (
    <main className="min-h-screen p-4">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-start justify-between gap-4">
            <h1 className="text-3xl font-bold tracking-tight text-white">Clipping de LeBarv__</h1>
            <LanguageSwitch />
          </div>
          <p className="mt-1 text-sm text-gray-400">
            {t.designedBy}{" "}
            <a
              href="https://www.twitch.tv/lebarv_pnj"
              target="_blank"
              rel="noopener noreferrer"
              className="text-purple-400 hover:text-purple-300 underline"
            >
              LeBarv_PNJ__VKS
            </a>
          </p>
          <p className="mt-2 text-xs text-gray-500">{t.loginNote}</p>
        </div>

        {/* URL Input */}
        <div className="mb-4">
          <label htmlFor="url" className="mb-1 block text-sm font-medium text-gray-300">
            {t.videoUrl}
          </label>
          <input
            id="url"
            type="text"
            required
            placeholder="https://www.twitch.tv/videos/123456789"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (analyzeStatus !== "idle") {
                setAnalyzeStatus("idle");
                setMoments([]);
                setTimeline([]);
                setSelectedMomentIdx(null);
              }
            }}
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        {/* Video + Chat side-by-side (Twitch VODs only) */}
        {isTwitch && videoId && (
          <div className="mb-6 flex flex-col gap-4 lg:flex-row">
            {/* Video Player - takes 2/3 width, sets the row height */}
            <div className="lg:w-2/3">
              <TwitchPlayer
                videoId={videoId}
                onTimeUpdate={setCurrentTime}
                playerRef={playerRef}
              />

              {/* Highlight navigation, right under the video */}
              {moments.length > 0 && (() => {
                const current = selectedMomentIdx !== null ? moments[selectedMomentIdx] : null;
                const cfg = current ? (TAG_CONFIG[current.tag] ?? TAG_CONFIG.hype) : null;
                return (
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => stepMoment(-1)}
                      title={t.prevTitle}
                      className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm font-semibold text-gray-300 transition hover:border-gray-600 hover:bg-gray-700"
                    >
                      &larr; {t.prev}
                    </button>
                    <div className="flex min-w-0 flex-1 items-center justify-center gap-2 truncate rounded-lg bg-gray-900 px-3 py-2.5 text-sm text-gray-300">
                      {current && cfg ? (
                        <>
                          <span className="font-mono text-xs text-gray-500">
                            {selectedMomentIdx! + 1}/{moments.length}
                          </span>
                          <span
                            className={`inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cfg.color} ${cfg.bg} ${cfg.border}`}
                          >
                            <span>{cfg.emoji}</span>
                            <span>{t.tag[current.tag]}</span>
                          </span>
                          <span className="truncate font-medium text-white">
                            {formatTime(current.startSec)} &ndash; {formatTime(current.endSec)}
                          </span>
                        </>
                      ) : (
                        <span className="text-gray-400">{t.highlightsFound(moments.length)}</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => stepMoment(1)}
                      title={t.nextTitle}
                      className="rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-semibold text-white shadow transition hover:bg-purple-500"
                    >
                      {selectedMomentIdx === null ? t.firstHighlight : t.nextHighlight} &rarr;
                    </button>
                  </div>
                );
              })()}
            </div>
            {/* Chat Replay Panel - 1/3 width, matches video height */}
            <div className="h-[400px] lg:h-auto lg:w-1/3 lg:aspect-video">
              <ChatReplayPanel
                url={url}
                currentTime={currentTime}
                onSeek={(seconds) => {
                  if (playerRef.current) {
                    try {
                      playerRef.current.seek(seconds);
                      playerRef.current.play();
                    } catch {
                      // Player might not support seek yet
                    }
                  }
                }}
              />
            </div>
          </div>
        )}

        {/* Chat Analysis & Highlights */}
        <div className="rounded-2xl bg-gray-900 p-6 shadow-xl">
          <h2 className="mb-4 text-lg font-semibold text-white">{t.analysisTitle}</h2>

          {/* Detect Highlights button */}
          {isTwitch && (
            <button
              type="button"
              onClick={handleAnalyze}
              disabled={analyzeStatus === "analyzing"}
              className="w-full rounded-lg border border-purple-500 bg-purple-500/10 px-4 py-2.5 text-sm font-semibold text-purple-300 transition hover:bg-purple-500/20 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 focus:ring-offset-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {analyzeStatus === "analyzing"
                ? t.analyzing
                : analyzeStatus === "done"
                  ? t.reanalyze
                  : t.detect}
            </button>
          )}

          {isTwitch && <KeywordEditor keywords={keywords} onChange={updateKeywords} />}

          {analyzeStatus === "analyzing" && (
            <div className="mt-4 flex items-center gap-2 text-sm text-purple-300">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {t.scanningChat}
            </div>
          )}

          {analyzeStatus === "error" && (
            <p className="mt-4 text-sm text-red-400">{t.analysisError} {analyzeError}</p>
          )}

          {analyzeStatus === "idle" && !isTwitch && (
            <p className="text-sm text-gray-500">
              {t.enterUrl}
            </p>
          )}

          {analyzeStatus === "idle" && isTwitch && (
            <p className="mt-4 text-sm text-gray-500">
              {t.clickDetect}
            </p>
          )}

          {analyzeStatus === "done" && moments.length > 0 && (
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-400">
                  {rich(t.foundHighlights(moments.length, totalMessages.toLocaleString()), "font-semibold text-purple-300")}
                </p>
                {/* Tag distribution summary */}
                <div className="flex items-center gap-1.5">
                  {(Object.keys(TAG_CONFIG) as HighlightTag[]).map((tag) => {
                    const count = moments.filter((m) => m.tag === tag).length;
                    if (count === 0) return null;
                    const cfg = TAG_CONFIG[tag];
                    return (
                      <span
                        key={tag}
                        className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${cfg.color} ${cfg.bg} ${cfg.border} border`}
                        title={t.tagCountTitle(count, t.tag[tag])}
                      >
                        <span>{cfg.emoji}</span>
                        <span>{count}</span>
                      </span>
                    );
                  })}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {moments.map((m, i) => {
                  const pct = Math.round((m.score / maxScore) * 100);
                  const isSelected = selectedMomentIdx === i;
                  const tagCfg = TAG_CONFIG[m.tag] ?? TAG_CONFIG.hype;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => selectMoment(m, i)}
                      className={`rounded-lg border px-3 py-2 text-left transition ${
                        isSelected
                          ? "border-indigo-500 bg-indigo-500/20"
                          : "border-gray-700 bg-gray-800 hover:border-gray-600"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono text-gray-500">#{i + 1}</span>
                          <span className="text-sm font-medium text-white">
                            {formatTime(m.startSec)} &ndash; {formatTime(m.endSec)}
                          </span>
                          {/* Highlight type tag */}
                          <span
                            className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${tagCfg.color} ${tagCfg.bg} ${tagCfg.border} border`}
                          >
                            <span>{tagCfg.emoji}</span>
                            <span>{t.tag[m.tag] ?? tagCfg.label}</span>
                          </span>
                        </div>
                        <span className="text-xs text-gray-400">
                          {m.messageCount} {t.msgs} &middot; {m.messagesPerSec}/s
                        </span>
                      </div>
                      {/* Score bar with tag-specific gradient */}
                      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-gray-700">
                        <div
                          className={`h-full rounded-full bg-gradient-to-r ${tagCfg.gradient}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      {m.burstScore > 0 && (
                        <p className="mt-1 text-[10px] text-violet-400">
                          {t.burstDetected(m.burstScore.toFixed(1))}
                        </p>
                      )}
                      {m.keywords && m.keywords.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {m.keywords.slice(0, 5).map((k) => {
                            const kc = TAG_CONFIG[k.category] ?? TAG_CONFIG.hype;
                            return (
                              <span
                                key={`${k.category}:${k.word}`}
                                className={`rounded px-1.5 py-0.5 text-[10px] ${kc.color} ${kc.bg}`}
                                title={t.keywordTitle(k.count, k.word)}
                              >
                                {k.word} &times;{k.count}
                              </span>
                            );
                          })}
                        </div>
                      )}
                      {m.sampleMessages.length > 0 && (
                        <p className="mt-1 truncate text-xs text-gray-500">
                          {m.sampleMessages.slice(0, 3).join(" · ")}
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Chat Activity Graph */}
          {analyzeStatus === "done" && timeline.length > 0 && (
            <div className="mt-5">
              <p className="mb-2 text-xs font-medium text-gray-400">{t.chatActivity}</p>
              <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-2">
                <ChatActivityChart
                  timeline={timeline}
                  moments={moments}
                  onSeek={(seconds) => {
                    if (playerRef.current) {
                      try {
                        playerRef.current.seek(seconds);
                        playerRef.current.play();
                      } catch {
                        // Player might not support seek yet
                      }
                    }
                    requestAnimationFrame(() => {
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    });
                  }}
                />
              </div>
              {moments.length > 0 && (
                <p className="mt-1.5 text-[10px] text-gray-500">
                  {t.chartHint}
                </p>
              )}
            </div>
          )}

          {analyzeStatus === "done" && moments.length === 0 && (
            <p className="mt-4 text-sm text-gray-400">
              {t.noHighlights}
            </p>
          )}
        </div>

        {/* How highlights are picked — explanation section */}
        {analyzeStatus === "done" && moments.length > 0 && (
          <div className="mt-6 rounded-2xl bg-gray-900 p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-white">{t.howTitle}</h2>
            <div className="space-y-4 text-sm text-gray-400 leading-relaxed">
              <p>{rich(t.howIntro("Clipping de LeBarv__"))}</p>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {/* Step 1 */}
                <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-3">
                  <p className="mb-1 text-xs font-semibold text-purple-300">{t.step1Title}</p>
                  <p className="text-xs text-gray-400">{t.step1}</p>
                </div>
                {/* Step 2 */}
                <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-3">
                  <p className="mb-1 text-xs font-semibold text-purple-300">{t.step2Title}</p>
                  <p className="text-xs text-gray-400">
                    <span className="text-red-300">{t.plural.ban}</span> {rich(t.step2Ban)}{" "}
                    <span className="text-purple-300">{t.plural.sub}</span> {rich(t.step2Sub)}{" "}
                    <span className="text-yellow-300">{t.plural.fun}</span> {rich(t.step2Fun)}{" "}
                    <span className="text-orange-300">{t.plural.hype}</span> {rich(t.step2Hype)}{" "}
                    <span className="text-emerald-300">{t.plural.donation}</span> {rich(t.step2Don)}
                  </p>
                </div>
                {/* Step 3 */}
                <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-3">
                  <p className="mb-1 text-xs font-semibold text-purple-300">{t.step3Title}</p>
                  <p className="text-xs text-gray-400">{t.step3}</p>
                </div>
                {/* Step 4 */}
                <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-3">
                  <p className="mb-1 text-xs font-semibold text-purple-300">{t.step4Title}</p>
                  <p className="text-xs text-gray-400">{t.step4}</p>
                </div>
              </div>

              <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-3">
                <p className="mb-1 text-xs font-semibold text-purple-300">{t.step5Title}</p>
                <p className="text-xs text-gray-400">{rich(t.step5)}</p>
              </div>

              <div className="flex flex-wrap gap-3 pt-1">
                {(Object.keys(TAG_CONFIG) as HighlightTag[]).map((tag) => {
                  const cfg = TAG_CONFIG[tag];
                  return (
                    <div key={tag} className="flex items-center gap-1.5">
                      <span className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${cfg.color} ${cfg.bg} ${cfg.border} border`}>
                        <span>{cfg.emoji}</span>
                        <span>{t.tag[tag]}</span>
                      </span>
                      <span className="text-[10px] text-gray-500">{t.legend[tag]}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Highlight scan counter */}
        <div className="mt-6 flex justify-center">
          <HighlightScanCounter value={analyzeCount} />
        </div>

        {/* Footer */}
        <p className="mt-6 text-center text-xs text-gray-500">
          {t.footerHint}
        </p>
        <p className="mt-4 text-center text-xs text-gray-600">
          {t.developedBy}{" "}
          <a
            href="https://www.twitch.tv/lebarv_pnj"
            target="_blank"
            rel="noopener noreferrer"
            className="text-purple-400 hover:text-purple-300 underline"
          >
            LeBarv_PNJ__VKS
          </a>
        </p>
      </div>
    </main>
  );
}
