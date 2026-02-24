"use client";

import { useState, type FormEvent } from "react";

type Status = "idle" | "processing" | "success" | "error";

export default function Home() {
  const [url, setUrl] = useState("");
  const [start, setStart] = useState("00:00:00");
  const [end, setEnd] = useState("00:01:00");
  const [format, setFormat] = useState("landscape");
  const [limit60, setLimit60] = useState(true);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");

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

      // Download the file
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

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-2xl bg-gray-900 p-8 shadow-2xl">
        <h1 className="mb-1 text-3xl font-bold tracking-tight text-white">
          QuickClip
        </h1>
        <p className="mb-6 text-sm text-gray-400">
          Paste a video URL, pick your clip range, and download. Supports
          Twitch VODs and direct .mp4/.m3u8 links.
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* URL */}
          <div>
            <label htmlFor="url" className="mb-1 block text-sm font-medium text-gray-300">
              Video URL
            </label>
            <input
              id="url"
              type="url"
              required
              placeholder="https://www.twitch.tv/videos/123456789"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

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
        <div className="mt-5">
          {status === "processing" && (
            <div className="flex items-center gap-2 text-sm text-yellow-400">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Generating your clip... This may take a moment.
            </div>
          )}
          {status === "success" && (
            <p className="text-sm text-green-400">
              Clip generated! Your download should start automatically.
            </p>
          )}
          {status === "error" && (
            <p className="text-sm text-red-400">
              Error: {errorMsg}
            </p>
          )}
        </div>

        {/* Info */}
        <p className="mt-6 text-xs text-gray-500">
          Supports Twitch VOD URLs and direct .mp4/.m3u8 links.
        </p>
      </div>
    </main>
  );
}
