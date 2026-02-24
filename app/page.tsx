"use client";

import { useState, useEffect, useRef, type FormEvent } from "react";

type Status = "idle" | "processing" | "success" | "error";
type AnalyzeStatus = "idle" | "analyzing" | "done" | "error";

interface HypeMoment {
  startSec: number;
  endSec: number;
  score: number;
  messagesPerSec: number;
  messageCount: number;
  sampleMessages: string[];
}

interface ChatMsg {
  offsetSeconds: number;
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

function ChatReplayPanel({
  url,
  currentTime,
}: {
  url: string;
  currentTime: number;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const fetchingRef = useRef(false);

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

  // Auto-scroll: keep the chat scrolled to the bottom as new messages appear
  useEffect(() => {
    if (!autoScroll || !chatEndRef.current) return;
    chatEndRef.current.scrollIntoView({ behavior: "smooth" });
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

  return (
    <div className="flex h-full flex-col rounded-lg border border-gray-700 bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-700 px-3 py-2">
        <span className="text-sm font-semibold text-gray-300">Chat Replay</span>
        <span className="text-xs text-gray-500">
          {visibleMessages.length} / {messages.length} msgs
        </span>
      </div>

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
        <div ref={chatEndRef} />
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
            chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
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
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function Home() {
  const [url, setUrl] = useState("");
  const [start, setStart] = useState("00:00:00");
  const [end, setEnd] = useState("00:01:00");
  const [format, setFormat] = useState("landscape");
  const [limit60, setLimit60] = useState(true);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  // Chat analysis state
  const [analyzeStatus, setAnalyzeStatus] = useState<AnalyzeStatus>("idle");
  const [analyzeError, setAnalyzeError] = useState("");
  const [moments, setMoments] = useState<HypeMoment[]>([]);
  const [totalMessages, setTotalMessages] = useState(0);

  // Video / chat sync state
  const [currentTime, setCurrentTime] = useState(0);
  const playerRef = useRef<any>(null);

  const isTwitch = isTwitchVodUrl(url);
  const videoId = isTwitch ? extractVideoId(url) : null;

  async function handleAnalyze() {
    setAnalyzeStatus("analyzing");
    setAnalyzeError("");
    setMoments([]);

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

  function selectMoment(moment: HypeMoment) {
    setStart(formatTime(moment.startSec));
    setEnd(formatTime(moment.endSec));
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("processing");
    setErrorMsg("");

    try {
      const res = await fetch("/api/clip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, start, end, format, limit60 }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(data.error || `Server error ${res.status}`);
      }

      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = "quickclip.mp4";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);

      setStatus("success");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  const maxScore = moments.length > 0 ? Math.max(...moments.map((m) => m.score)) : 1;

  return (
    <main className="min-h-screen p-4">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-3xl font-bold tracking-tight text-white">QuickClip</h1>
          <p className="mt-1 text-sm text-gray-400">
            Paste a Twitch VOD URL to preview video, browse chat, detect highlights, and clip.
          </p>
        </div>

        {/* URL Input */}
        <div className="mb-4">
          <label htmlFor="url" className="mb-1 block text-sm font-medium text-gray-300">
            Video URL
          </label>
          <input
            id="url"
            type="url"
            required
            placeholder="https://www.twitch.tv/videos/123456789"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (analyzeStatus !== "idle") {
                setAnalyzeStatus("idle");
                setMoments([]);
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
              <ChatReplayPanel url={url} currentTime={currentTime} />
            </div>
          </div>
        )}

        {/* Controls + Highlights side-by-side */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Left: Clip controls */}
          <div className="rounded-2xl bg-gray-900 p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-white">Clip Settings</h2>

            <form onSubmit={handleSubmit} className="space-y-4">
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
                <div className="flex items-center gap-2 text-sm text-purple-300">
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Scanning chat replay for reactions, emotes &amp; hype moments...
                </div>
              )}

              {analyzeStatus === "error" && (
                <p className="text-sm text-red-400">Analysis error: {analyzeError}</p>
              )}

              {/* Start / End */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="start" className="mb-1 block text-sm font-medium text-gray-300">
                    Start (HH:MM:SS)
                  </label>
                  <input
                    id="start"
                    type="text"
                    required
                    pattern="\d{1,2}:\d{2}:\d{2}"
                    placeholder="00:00:00"
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                    className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label htmlFor="end" className="mb-1 block text-sm font-medium text-gray-300">
                    End (HH:MM:SS)
                  </label>
                  <input
                    id="end"
                    type="text"
                    required
                    pattern="\d{1,2}:\d{2}:\d{2}"
                    placeholder="00:01:00"
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                    className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
              </div>

              {/* Set from player */}
              {isTwitch && (
                <button
                  type="button"
                  onClick={() => {
                    try {
                      const t = Math.floor(playerRef.current?.getCurrentTime?.() ?? 0);
                      setStart(formatTime(t));
                      setEnd(formatTime(t + 30));
                    } catch {
                      /* player not ready */
                    }
                  }}
                  className="text-xs text-indigo-400 hover:text-indigo-300 transition"
                >
                  Set start from current player position
                </button>
              )}

              {/* Format */}
              <div>
                <label htmlFor="format" className="mb-1 block text-sm font-medium text-gray-300">
                  Format
                </label>
                <select
                  id="format"
                  value={format}
                  onChange={(e) => setFormat(e.target.value)}
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="landscape">16:9 Landscape</option>
                  <option value="vertical">9:16 Vertical</option>
                  <option value="square">1:1 Square</option>
                </select>
              </div>

              {/* Limit 60s */}
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={limit60}
                  onChange={(e) => setLimit60(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-600 bg-gray-800 text-indigo-500 focus:ring-indigo-500"
                />
                Limit to 60 seconds
              </label>

              {/* Submit */}
              <button
                type="submit"
                disabled={status === "processing"}
                className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {status === "processing" ? "Processing..." : "Generate Clip"}
              </button>
            </form>

            {/* Status */}
            <div className="mt-4">
              {status === "processing" && (
                <div className="flex items-center gap-2 text-sm text-yellow-400">
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Generating your clip...
                </div>
              )}
              {status === "success" && (
                <p className="text-sm text-green-400">
                  Clip generated! Your download should start automatically.
                </p>
              )}
              {status === "error" && (
                <p className="text-sm text-red-400">Error: {errorMsg}</p>
              )}
            </div>
          </div>

          {/* Right: Detected highlights */}
          <div className="rounded-2xl bg-gray-900 p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-white">Detected Highlights</h2>

            {analyzeStatus === "idle" && isTwitch && (
              <p className="text-sm text-gray-500">
                Click &ldquo;Detect Highlights from Chat&rdquo; to find the best moments.
              </p>
            )}

            {analyzeStatus === "idle" && !isTwitch && (
              <p className="text-sm text-gray-500">
                Enter a Twitch VOD URL to detect highlights from chat replay.
              </p>
            )}

            {analyzeStatus === "done" && moments.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-gray-400">
                  Found {moments.length} highlight{moments.length !== 1 ? "s" : ""} from{" "}
                  {totalMessages.toLocaleString()} chat messages. Click to select &amp; preview:
                </p>
                <div className="max-h-[400px] space-y-1.5 overflow-y-auto pr-1">
                  {moments.map((m, i) => {
                    const pct = Math.round((m.score / maxScore) * 100);
                    const isSelected =
                      start === formatTime(m.startSec) && end === formatTime(m.endSec);
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => selectMoment(m)}
                        className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                          isSelected
                            ? "border-indigo-500 bg-indigo-500/20"
                            : "border-gray-700 bg-gray-800 hover:border-gray-600"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-white">
                            {formatTime(m.startSec)} &ndash; {formatTime(m.endSec)}
                          </span>
                          <span className="text-xs text-gray-400">
                            {m.messageCount} msgs &middot; {m.messagesPerSec}/s
                          </span>
                        </div>
                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-gray-700">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-purple-500 to-pink-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
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
              <p className="text-sm text-gray-400">
                No clear highlights found. The chat may be too quiet or evenly distributed.
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <p className="mt-6 text-center text-xs text-gray-500">
          Supports Twitch VOD URLs and direct .mp4/.m3u8 links.
          For Twitch VODs, the video and chat are extracted for preview and auto-highlight detection.
        </p>
      </div>
    </main>
  );
}
