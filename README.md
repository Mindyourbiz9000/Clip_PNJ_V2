# Clip_PNJ

Generate downloadable video clips from a direct video URL. Paste a link, pick start/end times and aspect ratio, and get an MP4 download.

## Features

- Cut clips from direct `.mp4` or `.m3u8` video URLs
- Choose aspect ratio: 16:9 (landscape), 9:16 (vertical), 1:1 (square)
- Server-side FFmpeg encoding with libx264
- SSRF-safe URL validation with DNS resolution checks
- Concurrency limiting and FFmpeg timeout protection
- No database, no accounts, no history — just clip and download

## Requirements

- **Docker** and **Docker Compose** (recommended)
- Or: **Node.js 20+** and **FFmpeg** installed locally

## Quick Start (Docker Compose)

```bash
# Clone the repo
git clone <repo-url> && cd Clip_PNJ_V2

# Start the app
docker compose up --build

# Open http://localhost:3000
```

## Local Development (without Docker)

```bash
# Make sure FFmpeg is installed
ffmpeg -version

# Install dependencies
npm install

# Run dev server
npm run dev

# Open http://localhost:3000
```

## How to Use

1. Open http://localhost:3000
2. Paste a **direct** video URL (must end in `.mp4` or `.m3u8`)
3. Set the start and end times in `HH:MM:SS` format
4. Choose your output format (landscape / vertical / square)
5. Click **Generate Clip**
6. The MP4 will download automatically when ready

### Example Input URLs

```
https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4
https://cdn.example.com/stream/playlist.m3u8
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MAX_CLIP_SECONDS` | `60` | Max clip duration in seconds |
| `FFMPEG_TIMEOUT_SECONDS` | `120` | FFmpeg process timeout |
| `MAX_CONCURRENT` | `1` | Max concurrent FFmpeg processes |
| `TMP_DIR` | `/tmp` | Temp directory for output files |
| `PORT` | `3000` | Server port |

## API

### `POST /api/clip`

**Request body (JSON):**

```json
{
  "url": "https://example.com/video.mp4",
  "start": "00:00:05",
  "end": "00:00:35",
  "format": "landscape",
  "limit60": true
}
```

**Responses:**

| Status | Description |
|---|---|
| `200` | MP4 binary (Content-Disposition: attachment) |
| `400` | Validation error (JSON `{ error }`) |
| `413` | Duration exceeds limit |
| `504` | FFmpeg timed out |
| `500` | Unexpected server error |

## Limitations

- **Direct URLs only** — the URL must point directly to an `.mp4` file or `.m3u8` playlist
- **No YouTube / Twitch / etc.** — streaming platform URLs are not supported (TOS risk). Use a direct URL or convert first
- **Max clip duration** — defaults to 60 seconds (configurable via `MAX_CLIP_SECONDS`)
- **Single concurrent encode** — by default only one FFmpeg process runs at a time

## Security

- SSRF protection: blocks private IPs (`10.x`, `172.16.x`, `192.168.x`, `169.254.x`, loopback), resolves DNS before connecting
- No credentials allowed in URLs
- URL allowlist: only `.mp4` and `.m3u8` extensions
- FFmpeg timeout prevents resource exhaustion
- Temp files are always cleaned up (even on errors)
- In-memory concurrency semaphore prevents overload

## Troubleshooting

| Problem | Solution |
|---|---|
| "Could not resolve hostname" | Check that the URL is reachable from the server |
| "URL resolves to a private address" | SSRF protection blocks internal URLs — use a public URL |
| "FFmpeg timed out" | The video may be too large or the source too slow. Try a shorter clip |
| "FFmpeg processing failed" | The URL may not be a valid video, or the format is unsupported |
| Empty/corrupted download | Check that the source URL is a direct video link, not an HTML page |
| Docker build fails | Ensure Docker has internet access to pull base images and FFmpeg |

## Tech Stack

- **Next.js 14** (App Router, TypeScript)
- **Tailwind CSS**
- **FFmpeg** (libx264 encoding)
- **Docker Compose**
