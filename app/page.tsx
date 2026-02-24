"use client";

import { useState, useEffect, useRef } from "react";

type AnalyzeStatus = "idle" | "analyzing" | "done" | "error";

type HighlightTag = "fun" | "hype" | "shock" | "love" | "toxic" | "spam";

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
}

/** Visual config for each highlight tag */
const TAG_CONFIG: Record<HighlightTag, { label: string; emoji: string; color: string; bg: string; border: string; gradient: string }> = {
  fun:   { label: "Fun",   emoji: "😂", color: "text-yellow-300", bg: "bg-yellow-500/15", border: "border-yellow-500/40", gradient: "from-yellow-500 to-amber-500" },
  hype:  { label: "Hype",  emoji: "🔥", color: "text-orange-300", bg: "bg-orange-500/15", border: "border-orange-500/40", gradient: "from-orange-500 to-red-500" },
  shock: { label: "Shock", emoji: "😱", color: "text-cyan-300",   bg: "bg-cyan-500/15",   border: "border-cyan-500/40",   gradient: "from-cyan-500 to-blue-500" },
  love:  { label: "Love",  emoji: "❤️", color: "text-pink-300",   bg: "bg-pink-500/15",   border: "border-pink-500/40",   gradient: "from-pink-500 to-rose-500" },
  toxic: { label: "Toxic", emoji: "☠️", color: "text-red-300",    bg: "bg-red-500/15",    border: "border-red-500/40",    gradient: "from-red-500 to-rose-600" },
  spam:  { label: "Spam",  emoji: "🌊", color: "text-violet-300", bg: "bg-violet-500/15", border: "border-violet-500/40", gradient: "from-violet-500 to-purple-500" },
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
        const data = await res.json().catch(() => ({ error: "Failed to load chat" }));
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
      setError(err instanceof Error ? err.message : "Failed to load chat");
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
        const data = await res.json().catch(() => ({ error: "Search failed" }));
        throw new Error(data.error);
      }
      const data = await res.json();
      setSearchResults(data.hits ?? []);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
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
        <span className="text-sm font-semibold text-gray-300">Chat Replay</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">
            {visibleMessages.length} / {messages.length} msgs
          </span>
          <button
            onClick={() => {
              setSearchOpen((prev) => !prev);
              if (!searchOpen) {
                setTimeout(() => searchInputRef.current?.focus(), 50);
              }
            }}
            title="Search chat"
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
              placeholder="Search chat messages..."
              className="flex-1 rounded border border-gray-600 bg-gray-900 px-2.5 py-1.5 text-xs text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              type="submit"
              disabled={searching || searchQuery.trim().length < 2}
              className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {searching ? "..." : "Search"}
            </button>
          </form>

          {/* Search results */}
          {searching && (
            <div className="flex items-center gap-1.5 text-xs text-gray-400">
              <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Scanning full chat replay...
            </div>
          )}

          {searchError && <p className="text-xs text-red-400">{searchError}</p>}

          {!searching && searchResults.length > 0 && (
            <div className="max-h-48 overflow-y-auto space-y-0.5">
              <p className="text-xs text-gray-500 mb-1">
                {searchResults.length} result{searchResults.length !== 1 ? "s" : ""} found
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
            <p className="text-xs text-gray-500">No results. Try a different keyword.</p>
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
            Chat messages will appear here as the video plays...
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
            Loading chat...
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
          Resume auto-scroll
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Highlight Scan Counter                                             */
/* ------------------------------------------------------------------ */

function HighlightScanCounter({ value }: { value: number }) {
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
        Highlight scans performed
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function Home() {
  const [url, setUrl] = useState("");

  // Chat analysis state
  const [analyzeStatus, setAnalyzeStatus] = useState<AnalyzeStatus>("idle");
  const [analyzeError, setAnalyzeError] = useState("");
  const [moments, setMoments] = useState<HypeMoment[]>([]);
  const [totalMessages, setTotalMessages] = useState(0);
  const [selectedMomentIdx, setSelectedMomentIdx] = useState<number | null>(null);

  // Highlight detection counter (persisted in localStorage)
  const [analyzeCount, setAnalyzeCount] = useState(0);
  useEffect(() => {
    const stored = localStorage.getItem("analyzeCount");
    if (stored) setAnalyzeCount(parseInt(stored, 10) || 0);
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
    setSelectedMomentIdx(null);

    // Increment the mechanical counter
    setAnalyzeCount((prev) => {
      const next = prev + 1;
      localStorage.setItem("analyzeCount", String(next));
      return next;
    });

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(data.error || `Server error ${res.status}`);
      }

      const data = await res.json();
      setMoments(data.moments ?? []);
      setTotalMessages(data.totalMessages ?? 0);
      setAnalyzeStatus("done");
    } catch (err) {
      setAnalyzeStatus("error");
      setAnalyzeError(err instanceof Error ? err.message : "Analysis failed");
    }
  }

  function selectMoment(moment: HypeMoment, index: number) {
    // Remove focus from the clicked button so the browser doesn't
    // try to keep the focused element visible.
    (document.activeElement as HTMLElement)?.blur();
    setSelectedMomentIdx(index);

    // Wait for React to finish re-rendering (the selected highlight
    // changes style) before scrolling, so the browser's layout-driven
    // scroll doesn't fight ours.
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

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

  const maxScore = moments.length > 0 ? Math.max(...moments.map((m) => m.score)) : 1;

  return (
    <main className="min-h-screen p-4">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-3xl font-bold tracking-tight text-white">Clip_PNJ</h1>
          <p className="mt-1 text-sm text-gray-400">
            Designed by{" "}
            <a
              href="https://www.twitch.tv/lebarv_pnj"
              target="_blank"
              rel="noopener noreferrer"
              className="text-purple-400 hover:text-purple-300 underline"
            >
              LeBarv_PNJ
            </a>
            , from{" "}
            <a
              href="https://www.twitch.tv/inespnj"
              target="_blank"
              rel="noopener noreferrer"
              className="text-purple-400 hover:text-purple-300 underline"
            >
              InesPNJ
            </a>
            &apos;s community
          </p>
          <p className="mt-2 text-xs text-gray-500">
            🇫🇷 Si vous êtes déjà connecté à Twitch, vous pouvez accéder à la fonctionnalité de clip. Si vous ne voyez pas l&apos;option clip, veuillez vous connecter à Twitch dans une autre fenêtre.
          </p>
          <p className="mt-1 text-xs text-gray-500">
            🇬🇧 If you are already logged in to Twitch, you can access the clip functionality. If you don&apos;t see the clip option, please make sure you log in to Twitch in another window.
          </p>
        </div>

        {/* URL Input */}
        <div className="mb-4">
          <label htmlFor="url" className="mb-1 block text-sm font-medium text-gray-300">
            Video URL
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
          <h2 className="mb-4 text-lg font-semibold text-white">Chat Analysis &amp; Highlights</h2>

          {/* Detect Highlights button */}
          {isTwitch && (
            <button
              type="button"
              onClick={handleAnalyze}
              disabled={analyzeStatus === "analyzing"}
              className="w-full rounded-lg border border-purple-500 bg-purple-500/10 px-4 py-2.5 text-sm font-semibold text-purple-300 transition hover:bg-purple-500/20 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 focus:ring-offset-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {analyzeStatus === "analyzing"
                ? "Analyzing chat..."
                : analyzeStatus === "done"
                  ? "Re-analyze Chat"
                  : "Detect Highlights from Chat"}
            </button>
          )}

          {analyzeStatus === "analyzing" && (
            <div className="mt-4 flex items-center gap-2 text-sm text-purple-300">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Scanning chat for laughter, hype, shock, love, toxicity &amp; spam bursts...
            </div>
          )}

          {analyzeStatus === "error" && (
            <p className="mt-4 text-sm text-red-400">Analysis error: {analyzeError}</p>
          )}

          {analyzeStatus === "idle" && !isTwitch && (
            <p className="text-sm text-gray-500">
              Enter a Twitch VOD URL to detect highlights from chat replay.
            </p>
          )}

          {analyzeStatus === "idle" && isTwitch && (
            <p className="mt-4 text-sm text-gray-500">
              Click &ldquo;Detect Highlights from Chat&rdquo; to scan chat replay and find the best moments.
            </p>
          )}

          {analyzeStatus === "done" && moments.length > 0 && (
            <div className="mt-4 space-y-3">
              <p className="text-xs text-gray-400">
                Found {moments.length} highlight{moments.length !== 1 ? "s" : ""} from{" "}
                {totalMessages.toLocaleString()} chat messages. Click to jump to a moment:
              </p>
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
                          <span className="text-sm font-medium text-white">
                            {formatTime(m.startSec)} &ndash; {formatTime(m.endSec)}
                          </span>
                          {/* Highlight type tag */}
                          <span
                            className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${tagCfg.color} ${tagCfg.bg} ${tagCfg.border} border`}
                          >
                            <span>{tagCfg.emoji}</span>
                            <span>{tagCfg.label}</span>
                          </span>
                        </div>
                        <span className="text-xs text-gray-400">
                          {m.messageCount} msgs &middot; {m.messagesPerSec}/s
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
                          Burst detected &middot; {m.burstScore.toFixed(1)} intensity
                        </p>
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

          {analyzeStatus === "done" && moments.length === 0 && (
            <p className="mt-4 text-sm text-gray-400">
              No clear highlights found. The chat may be too quiet or evenly distributed.
            </p>
          )}
        </div>

        {/* Highlight scan counter */}
        <div className="mt-6 flex justify-center">
          <HighlightScanCounter value={analyzeCount} />
        </div>

        {/* Footer */}
        <p className="mt-6 text-center text-xs text-gray-500">
          Paste a Twitch VOD URL to preview the video, browse chat replay, and detect highlight moments from chat activity.
        </p>
        <p className="mt-4 text-center text-xs text-gray-600">
          Developed by{" "}
          <a
            href="https://www.twitch.tv/lebarv_pnj"
            target="_blank"
            rel="noopener noreferrer"
            className="text-purple-400 hover:text-purple-300 underline"
          >
            LeBarv_PNJ
          </a>
        </p>
      </div>
    </main>
  );
}
