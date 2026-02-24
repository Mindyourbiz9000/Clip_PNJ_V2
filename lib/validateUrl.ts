import { resolve4, resolve6 } from "node:dns/promises";
import { isSupportedPlatformUrl } from "./resolveUrl";

const PRIVATE_RANGES = [
  // 10.0.0.0/8
  { start: 0x0a000000, end: 0x0affffff },
  // 172.16.0.0/12
  { start: 0xac100000, end: 0xac1fffff },
  // 192.168.0.0/16
  { start: 0xc0a80000, end: 0xc0a8ffff },
  // 169.254.0.0/16 (link-local)
  { start: 0xa9fe0000, end: 0xa9feffff },
  // 127.0.0.0/8 (loopback)
  { start: 0x7f000000, end: 0x7fffffff },
  // 0.0.0.0/8
  { start: 0x00000000, end: 0x00ffffff },
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return PRIVATE_RANGES.some((r) => n >= r.start && n <= r.end);
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  // IPv4-mapped IPv6 like ::ffff:127.0.0.1
  const v4match = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4match) return isPrivateIPv4(v4match[1]);
  return false;
}

const ALLOWED_EXTENSIONS = [".mp4", ".m3u8"];

export interface ValidationResult {
  valid: true;
  url: string;
}
export interface ValidationError {
  valid: false;
  error: string;
}

export async function validateUrl(
  raw: unknown
): Promise<ValidationResult | ValidationError> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { valid: false, error: "URL is required" };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  // Only http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, error: "Only http and https URLs are allowed" };
  }

  // Block credentials in URL
  if (parsed.username || parsed.password) {
    return { valid: false, error: "URLs with credentials are not allowed" };
  }

  // Block known loopback hostnames
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return { valid: false, error: "Loopback addresses are not allowed" };
  }

  // Check file extension (allowlist) — skip for supported platform URLs
  const normalizedUrl = parsed.toString();
  if (!isSupportedPlatformUrl(normalizedUrl)) {
    const pathname = parsed.pathname.toLowerCase();
    const hasAllowedExt = ALLOWED_EXTENSIONS.some((ext) => pathname.endsWith(ext));
    if (!hasAllowedExt) {
      return {
        valid: false,
        error: `URL must point to a supported file type: ${ALLOWED_EXTENSIONS.join(", ")}`,
      };
    }
  }

  // DNS resolution — reject if any resolved IP is private
  try {
    let ips: string[] = [];
    try {
      const a = await resolve4(hostname);
      ips = ips.concat(a);
    } catch {
      // no A records
    }
    try {
      const aaaa = await resolve6(hostname);
      ips = ips.concat(aaaa);
    } catch {
      // no AAAA records
    }

    if (ips.length === 0) {
      return { valid: false, error: "Could not resolve hostname" };
    }

    for (const ip of ips) {
      if (ip.includes(":")) {
        if (isPrivateIPv6(ip)) {
          return { valid: false, error: "URL resolves to a private/loopback address" };
        }
      } else {
        if (isPrivateIPv4(ip)) {
          return { valid: false, error: "URL resolves to a private/loopback address" };
        }
      }
    }
  } catch {
    return { valid: false, error: "DNS resolution failed" };
  }

  return { valid: true, url: parsed.toString() };
}
