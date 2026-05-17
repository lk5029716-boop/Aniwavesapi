/**
 * DGHG / PlayMogo / DoodStream provider extractor.
 *
 * Flow:
 *   1. GET embed page HTML → extract pass_md5 path and token
 *   2. GET /pass_md5/{file_id}-{random}/{token} → get CDN base URL
 *   3. Construct final URL: {cdnUrl}{random10chars}?token={token}&expiry={timestamp}
 *   4. Return direct MP4 URL
 */
import axios from "axios";
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime } from "../types.js";

const DOOD_HOSTS = [
  "playmogo.com", "myvidplay.com", "doodstream.com", "dood.la",
  "dood.to", "dood.so", "dood.ws", "dood.pm", "dood.wf", "dood.re",
  "dood.yt", "dood.cx", "dood.sh", "dood.watch",
];

const UA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36";

function isPlaymogoHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return DOOD_HOSTS.some((h) => host.includes(h));
  } catch {
    return false;
  }
}

function makeDghgDebug(step: number, reason: string, extra?: Record<string, unknown>) {
  return { _dghgDebug: { step, reason, ...extra } };
}

export async function extractDghg(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  const urlObj = new URL(embedUrl);
  const host = urlObj.hostname;

  logger.info({ embedUrl: embedUrl.slice(0, 100) }, "[DGHG] starting extraction");

  // Step 1: Fetch embed page HTML to extract pass_md5 path
  let html: string;
  try {
    const resp = await axios.get(embedUrl, {
      timeout: 15000,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,*/*",
        Referer: "https://aniwaves.ru/",
      },
    });
    html = resp.data as string;
  } catch (err) {
    const e = err as Error & { response?: { status: number } };
    logger.error({ error: e.message, status: e.response?.status }, "[DGHG] Step 1 FAILED — could not fetch embed page");
    return makeDghgDebug(1, e.message, { status: e.response?.status }) as unknown as StreamSource;
  }

  logger.debug({ htmlLen: html.length }, "[DGHG] fetched embed page");

  // Step 2: Extract pass_md5 path from HTML
  // Pattern: $.get('/pass_md5/{file_id}-{random}/{token}', function(data)
  let passMd5Path: string | null = null;
  const passMd5Match = html.match(/\$\.get\s*\(\s*['"]\/pass_md5\/([^'\"]+)['"]\s*,/);
  if (passMd5Match) {
    passMd5Path = passMd5Match[1];
  }

  if (!passMd5Path) {
    // Try alternative patterns
    const altMatch = html.match(/pass_md5\/([a-f0-9]+-\d+-\d+-\d+-[a-f0-9]+\/[^'"\s]+)/);
    if (altMatch) {
      passMd5Path = altMatch[1];
    }
  }

  if (!passMd5Path) {
    const htmlSnippet = html.slice(0, 300);
    logger.error({ htmlLen: html.length, htmlSnippet }, "[DGHG] Step 2 FAILED — no pass_md5 path found");
    return makeDghgDebug(2, "no pass_md5 in HTML", { htmlLen: html.length, htmlSnippet }) as unknown as StreamSource;
  }

  // Extract token from the pass_md5 path (last segment after /)
  const pathParts = passMd5Path.split("/");
  const token = pathParts[pathParts.length - 1] || null;

  if (!token) {
    logger.error("[DGHG] Step 2b FAILED — could not extract token");
    return makeDghgDebug(2, "no token in path") as unknown as StreamSource;
  }

  logger.debug({ passMd5Path, token: token.slice(0, 20) }, "[DGHG] extracted pass_md5 path");

  // Step 3: Call pass_md5 endpoint to get CDN base URL
  const passMd5Url = `https://${host}/pass_md5/${passMd5Path}`;
  let cdnBaseUrl: string;
  try {
    const resp = await axios.get(passMd5Url, {
      timeout: 15000,
      headers: {
        "User-Agent": UA,
        Accept: "*/*",
        Referer: embedUrl,
      },
      maxRedirects: 5,
    });
    cdnBaseUrl = (resp.data as string).trim();
  } catch (err) {
    const e = err as Error & { response?: { status: number } };
    logger.error({ error: e.message, status: e.response?.status }, "[DGHG] Step 3 FAILED — pass_md5 request failed");
    return makeDghgDebug(3, e.message, { status: e.response?.status, passMd5Url }) as unknown as StreamSource;
  }

  if (!cdnBaseUrl || !cdnBaseUrl.startsWith("http")) {
    logger.error({ cdnBase: cdnBaseUrl?.slice(0, 200) }, "[DGHG] Step 3 FAILED — invalid CDN URL");
    return makeDghgDebug(3, "invalid CDN URL", { cdnBase: cdnBaseUrl?.slice(0, 200) }) as unknown as StreamSource;
  }

  logger.debug({ cdnBase: cdnBaseUrl.slice(0, 100) }, "[DGHG] got CDN base URL");

  // Step 4: Construct final URL matching the makePlay() function from embed3.js
  // makePlay() generates 10 random chars + "?token={token}&expiry={timestamp}"
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let randomSuffix = "";
  for (let i = 0; i < 10; i++) {
    randomSuffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const expiry = Date.now();
  const finalUrl = `${cdnBaseUrl}${randomSuffix}?token=${token}&expiry=${expiry}`;

  logger.info({ finalUrl: finalUrl.slice(0, 120) }, "[DGHG] extraction SUCCESS");

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
