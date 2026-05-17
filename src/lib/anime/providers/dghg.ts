/**
 * DGHG / PlayMogo / DoodStream provider extractor.
 *
 * DGHG embeds use myvidplay.com (DoodStream-based CDN).
 * Flow:
 *   1. GET /e/{videoCode} → extract pass_md5 path from HTML
 *   2. GET /pass_md5/{path} → get CDN base URL (follows redirects)
 *   3. Append ?token={token}&expiry={timestamp} → final direct MP4 URL
 */
import axios from "axios";
import * as cheerio from "cheerio";
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime } from "../types.js";

const DOOD_HOSTS = [
  "playmogo.com", "myvidplay.com", "doodstream.com", "dood.la",
  "dood.to", "dood.so", "dood.ws", "dood.pm", "dood.wf", "dood.re",
  "dood.yt", "dood.cx", "dood.sh", "dood.watch",
];

function isPlaymogoHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return DOOD_HOSTS.some((h) => host.includes(h));
  } catch {
    return false;
  }
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function followPassMd5(passMd5Url: string, referer: string): Promise<string | null> {
  // Step 1: Hit pass_md5 — may get 301/302 redirect or direct CDN URL
  let location: string | null = null;
  try {
    const r = await axios.get(passMd5Url, {
      timeout: 15000,
      headers: { "User-Agent": UA, Referer: referer, Accept: "*/*" },
      maxRedirects: 0,
      validateStatus: (s) => s === 200 || s === 301 || s === 302,
    });
    if (r.status === 200) {
      const body = (r.data as string)?.trim();
      if (body && (body.startsWith("http") || body.startsWith("REDIRECT"))) return body;
    }
    location = r.headers["location"] ?? null;
  } catch {
    // ignore
  }

  // Step 2: Follow redirect if we got one
  if (location) {
    try {
      const r2 = await axios.get(location, {
        timeout: 15000,
        headers: { "User-Agent": UA, Referer: referer, Accept: "*/*" },
        maxRedirects: 5,
      });
      return (r2.data as string)?.trim() || null;
    } catch {
      return location.startsWith("http") ? location : null;
    }
  }

  return null;
}

export async function extractDghg(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  logger.info({ embedUrl: embedUrl.slice(0, 80) }, "[DGHG] starting extraction");

  // Step 1: Fetch embed page to get pass_md5 path and token
  let html: string;
  try {
    const resp = await axios.get(embedUrl, {
      timeout: 15000,
      headers: { "User-Agent": UA, Accept: "text/html,*/*", Referer: "https://aniwaves.ru/" },
      maxRedirects: 5,
    });
    html = resp.data as string;
  } catch (err) {
    logger.error({ error: (err as Error).message }, "[DGHG] Step 1 FAILED");
    return null;
  }

  // Step 2: Extract pass_md5 path from $.get('/pass_md5/...') in HTML
  let passMd5Path: string | null = null;
  const passMd5Match = html.match(/\$\.get\s*\(\s*['"]\/pass_md5\/([^'"]+)['"]\s*,/);
  if (passMd5Match) {
    passMd5Path = passMd5Match[1];
  }

  // Also try to extract token from pass_md5 path
  let token: string | null = null;
  if (passMd5Path) {
    const parts = passMd5Path.split("/");
    if (parts.length >= 2) token = parts[1];
  }

  // Fallback: extract token from cookieIndex or makePlay
  if (!token) {
    const tokenMatch = html.match(/cookieIndex\s*=\s*['"]([^'"]+)['"]/)
      || html.match(/makePlay\(\)[^?]*\?token=([a-zA-Z0-9]+)/);
    token = tokenMatch?.[1] ?? null;
  }

  logger.debug({ passMd5Path: passMd5Path?.slice(0, 50), token: token?.slice(0, 20) }, "[DGHG] extracted creds");

  if (!passMd5Path) {
    logger.error("[DGHG] Step 2 FAILED — no pass_md5 path in HTML");
    return null;
  }

  // Step 3: Call pass_md5 to get CDN URL
  const urlObj = new URL(embedUrl);
  const passMd5Url = `https://${urlObj.hostname}/pass_md5/${passMd5Path}`;

  const cdnBaseUrl = await followPassMd5(passMd5Url, embedUrl);
  if (!cdnBaseUrl) {
    logger.error("[DGHG] Step 3 FAILED — no CDN URL");
    return null;
  }

  // Step 4: Build final video URL
  const expiry = Date.now();
  const finalUrl = `${cdnBaseUrl}?token=${token}&expiry=${expiry}`;

  logger.info({ finalUrl: finalUrl.slice(0, 80) }, "[DGHG] extraction SUCCESS");

  let intro: SkipTime | null = null;
  let outro: SkipTime | null = null;
  if (skipData?.intro?.[1] && skipData.intro[1] > 0) {
    intro = { start: skipData.intro[0], end: skipData.intro[1] };
  }
  if (skipData?.outro?.[1] && skipData.outro[1] > 0) {
    outro = { start: skipData.outro[0], end: skipData.outro[1] };
  }

  return {
    type: "direct",
    provider: "dghg",
    m3u8: finalUrl,
    subtitles: [],
    thumbnails: null,
    intro,
    outro,
  };
}

export { isPlaymogoHost };
