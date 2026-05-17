/**
 * DGHG / PlayMogo / DoodStream provider extractor.
 *
 * Uses Playwright (Chromium) to fetch the embed page because myvidplay.com
 * blocks direct HTTP requests (axios/curl) with 403. Chromium looks like a
 * real browser and passes the Cloudflare check.
 *
 * Flow:
 *   1. Use Playwright to load embed page → extract pass_md5 path from HTML
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

export async function extractDghg(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  const urlObj = new URL(embedUrl);
  const host = urlObj.hostname;

  logger.info({ embedUrl: embedUrl.slice(0, 100) }, "[DGHG] starting extraction");

  // Step 1: Use Playwright to fetch embed page HTML
  // myvidplay.com blocks direct HTTP requests (403), so we need a real browser
  let html: string;
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const context = await browser.newContext({
      userAgent: UA,
      extraHTTPHeaders: {
        Referer: "https://aniwaves.ru/",
      },
    });
    const page = await context.newPage();

    // Navigate and wait for the page to load
    await page.goto(embedUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    // Wait a moment for any dynamic content
    await page.waitForTimeout(2000);

    html = await page.content();
    await browser.close();

    logger.debug({ htmlLen: html.length }, "[DGHG] Playwright fetched embed page");
  } catch (err) {
    const e = err as Error;
    logger.error({ error: e.message }, "[DGHG] Step 1 FAILED — Playwright could not fetch embed page");
    return null;
  }

  // Step 2: Extract pass_md5 path from HTML
  let passMd5Path: string | null = null;

  // Primary regex: $.get('/pass_md5/...', function(data)
  const passMd5Match = html.match(/\$\.get\s*\(\s*['"]\/pass_md5\/([^'\"]+)['"]\s*,/);
  if (passMd5Match) {
    passMd5Path = passMd5Match[1];
  }

  // Fallback: look for pass_md5/ pattern directly
  if (!passMd5Path) {
    const altMatch = html.match(/pass_md5\/([a-f0-9]+-\d+-\d+-\d+-[a-f0-9]+\/[^'"\s,)]+)/);
    if (altMatch) {
      passMd5Path = altMatch[1];
    }
  }

  // Fallback 2: look for any pass_md5/ path
  if (!passMd5Path) {
    const altMatch2 = html.match(/pass_md5\/([^'"\s,)]+)/);
    if (altMatch2) {
      passMd5Path = altMatch2[1];
    }
  }

  if (!passMd5Path) {
    logger.error({ htmlLen: html.length }, "[DGHG] Step 2 FAILED — no pass_md5 path found in HTML");
    return null;
  }

  // Extract token from the pass_md5 path (last segment after /)
  const pathParts = passMd5Path.split("/");
  const token = pathParts[pathParts.length - 1] || null;

  if (!token) {
    logger.error("[DGHG] Step 2b FAILED — could not extract token");
    return null;
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
    return null;
  }

  if (!cdnBaseUrl || !cdnBaseUrl.startsWith("http")) {
    logger.error({ cdnBase: cdnBaseUrl?.slice(0, 200) }, "[DGHG] Step 3 FAILED — invalid CDN URL");
    return null;
  }

  logger.debug({ cdnBase: cdnBaseUrl.slice(0, 100) }, "[DGHG] got CDN base URL");

  // Step 4: Construct final URL matching the makePlay() function from embed3.js
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
