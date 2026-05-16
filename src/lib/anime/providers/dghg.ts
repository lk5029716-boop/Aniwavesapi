/**
 * DGHG / PlayMogo / DoodStream extractor.
 *
 * DGHG embeds use playmogo.com (DoodStream-based CDN).
 * Returns a direct MP4 URL — no Playwright needed.
 *
 * Flow:
 * 1. GET /e/{videoCode} → extract file_id and token from HTML
 * 2. GET /pass_md5/{file_id}-{random}/{token} → get CDN base URL
 * 3. Append ?token={token}&expiry={timestamp} → final direct MP4 URL
 */
import axios from "axios";
import * as cheerio from "cheerio";
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime } from "../types.js";

const PLAYMOGO_HOSTS = [
  "playmogo.com", "myvidplay.com", "doodstream.com", "dood.la",
  "dood.to", "dood.so", "dood.ws", "dood.pm", "dood.wf", "dood.re",
  "dood.yt", "dood.cx", "dood.sh", "dood.watch",
];

export async function extractDghg(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  logger.info({ embedUrl: embedUrl.slice(0, 80) }, "[DGHG] starting extraction");

  const commonHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,*/*",
    Referer: "https://aniwaves.ru/",
  };

  // Step 1: Fetch embed page
  let html: string;
  try {
    const resp = await axios.get(embedUrl, {
      timeout: 15000,
      headers: commonHeaders,
      maxRedirects: 5,
    });
    html = resp.data as string;
  } catch (err) {
    logger.error({ error: (err as Error).message }, "[DGHG] Step 1 FAILED");
    return null;
  }

  // Step 2: Extract file_id and token
  const fileIdMatch = html.match(/file_id['"]\s*,\s*['"]([^'"]+)['"]/);
  const fileId = fileIdMatch?.[1] ?? null;

  const tokenMatch =
    html.match(/cookieIndex\s*=\s*['"]([^'"]+)['"]/) ||
    html.match(/pass_md5\/[^"]+\/([^"'\\/]+)['"]?/) ||
    html.match(/\?token=([a-zA-Z0-9]+)/);
  let token = tokenMatch?.[1] ?? null;

  const passMd5Match = html.match(
    /\$\.get\s*\(\s*['"]\/pass_md5\/([^'"]+)['"]/
  );
  let passMd5Path: string | null = null;
  if (passMd5Match) {
    passMd5Path = passMd5Match[1];
    if (!token) {
      const pathParts = passMd5Path.split("/");
      if (pathParts.length >= 2) token = pathParts[1] || null;
    }
  }

  if (!fileId && !passMd5Path) {
    logger.error("[DGHG] Step 2 FAILED — no file_id or pass_md5 path");
    return null;
  }

  // Step 3: Call /pass_md5 to get CDN URL
  const urlObj = new URL(embedUrl);
  const host = urlObj.hostname;
  let cdnBaseUrl: string | null = null;

  if (passMd5Path) {
    try {
      const passMd5Url = `https://${host}/pass_md5/${passMd5Path}`;
      const resp = await axios.get(passMd5Url, {
        timeout: 15000,
        headers: { ...commonHeaders, Referer: embedUrl },
        maxRedirects: 5,
      });
      cdnBaseUrl = (resp.data as string)?.trim() || null;
    } catch (err) {
      const e = err as Error & { response?: { data?: string } };
      if (e.response?.data) cdnBaseUrl = (e.response.data as string)?.trim() || null;
    }
  }

  if (!cdnBaseUrl && fileId && token) {
    const randomSuffix =
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15);
    const passMd5Path2 = `${fileId}-${randomSuffix}/${token}`;

    try {
      const passMd5Url = `https://${host}/pass_md5/${passMd5Path2}`;
      const resp = await axios.get(passMd5Url, {
        timeout: 15000,
        headers: { ...commonHeaders, Referer: embedUrl },
        maxRedirects: 0,
        validateStatus: (s) => s === 200 || s === 301 || s === 302,
      });
      cdnBaseUrl = (resp.data as string)?.trim() || null;
    } catch (err) {
      const e = err as Error & { response?: { data?: string } };
      if (e.response?.data) cdnBaseUrl = (e.response.data as string)?.trim() || null;
    }
  }

  if (!cdnBaseUrl) {
    logger.error("[DGHG] Step 3 FAILED — no CDN URL");
    return null;
  }

  // Step 4: Build final video URL
  const expiry = Date.now();
  const finalUrl = `${cdnBaseUrl}?token=${token}&expiry=${expiry}`;

  // Step 5: Build StreamSource
  let intro: SkipTime | null = null;
  let outro: SkipTime | null = null;
  if (skipData?.intro?.[1] && skipData.intro[1] > 0) {
    intro = { start: skipData.intro[0], end: skipData.intro[1] };
  }
  if (skipData?.outro?.[1] && skipData.outro[1] > 0) {
    outro = { start: skipData.outro[0], end: skipData.outro[1] };
  }

  logger.info("[DGHG] extraction complete — SUCCESS");

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

export function isDghgHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return PLAYMOGO_HOSTS.some((h) => host.includes(h));
  } catch {
    return false;
  }
}
