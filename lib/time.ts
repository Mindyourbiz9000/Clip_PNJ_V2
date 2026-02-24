const HH_MM_SS = /^(\d{1,2}):(\d{2}):(\d{2})$/;

export function parseTime(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(HH_MM_SS);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  if (min > 59 || sec > 59) return null;
  return h * 3600 + min * 60 + sec;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [
    h.toString().padStart(2, "0"),
    m.toString().padStart(2, "0"),
    s.toString().padStart(2, "0"),
  ].join(":");
}

export function validateTimes(
  startRaw: unknown,
  endRaw: unknown,
  limit60: boolean
): { startSec: number; endSec: number; duration: number } | { error: string } {
  const maxClip = parseInt(process.env.MAX_CLIP_SECONDS || "60", 10);

  const startSec = parseTime(startRaw);
  if (startSec === null) {
    return { error: "Invalid start time. Use HH:MM:SS format." };
  }

  const endSec = parseTime(endRaw);
  if (endSec === null) {
    return { error: "Invalid end time. Use HH:MM:SS format." };
  }

  if (endSec <= startSec) {
    return { error: "End time must be after start time." };
  }

  const duration = endSec - startSec;

  if (limit60 && duration > maxClip) {
    return { error: `Duration exceeds ${maxClip} second limit.` };
  }

  // Hard cap regardless of limit60
  const hardCap = Math.max(maxClip, 300); // never exceed 5 min even with limit60 off
  if (duration > hardCap) {
    return { error: `Duration exceeds hard cap of ${hardCap} seconds.` };
  }

  return { startSec, endSec, duration };
}
