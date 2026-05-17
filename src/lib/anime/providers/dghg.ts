/**
 * DGHG / PlayMogo / DoodStream provider extractor.
 *
 * Uses Playwright headless Chromium to load the embed page (bypasses Cloudflare),
 * then extracts the pass_md5 path and token from the HTML.
 *
 * Flow:
 *   1. Load embed page in headless browser → get HTML with pass_md5 path
 *   2. Extract pass_md5 path and token from HTML
 *   3. GET /pass_md5/{path} → get CDN base URL
 *   4. Build final URL: {cdnUrl}?token={token}&expiry={timestamp}
 */
import { execFileSync } from "child_process";
import axios from "axios";
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime } from "../types.js";

const DOOD_HOSTS = [
  "playmogo.com", "myvidplay.com", "doodstream.com", "dood.la",
  "dood.to", "dood.so", "dood.ws", "dood.pm", "dood.wf", "dood.re",
  "dood.yt", "dood.cx", "dood.sh", "dood.watch",
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function isPlaymogoHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return DOOD_HOSTS.some((h) => host.includes(h));
  } catch {
    return false;
  }
}

/**
 * Use Playwright to fetch the embed page HTML (bypasses Cloudflare).
 */
async function fetchEmbedPage(embedUrl: string): Promise<string | null> {
  let browser: import("playwright").Browser | null = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
    const context = await browser.newContext({
      userAgent: UA,
      extraHTTPHeaders: {
        Referer: "https://aniwaves.ru/",
      },
    });
    const page = await context.newPage();
    await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    const html = await page.content();
    await browser.close();
    return html;
  } catch (err) {
    logger.error({ error: (err as Error).message }, "[DGHG] Playwright fetch failed");
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

export async function extractDghg(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  logger.info({ embedUrl: embedUrl.slice(0, 100) }, "[DGHG] starting extraction");

  // Step 1: Fetch embed page via Playwright
  const html = await fetchEmbedPage(embedUrl);
  if (!html) {
    logger.error("[DGHG] Step 1 FAILED — could not fetch embed page");
    return null;
  }

  // Step 2: Extract pass_md5 path from HTML
  let passMd5Path: string | null = null;
  const passMd5Match = html.match(/\$\.get\s*\(\s*['"]\/pass_md5\/([^'"]+)['"]\s*,/);
  if (passMd5Match) passMd5Path = passMd5Match[1];

  let token: string | null = null;
  if (passMd5Path) {
    const parts = passMd5Path.split("/");
    token = parts[parts.length - 1] || null;
  }
  if (!token) {
    const tokenMatch = html.match(/cookieIndex\s*=\s*['"]([^'"]+)['"]/);
    token = tokenMatch?.[1] ?? null;
  }

  logger.debug({ passMd5Path: passMd5Path?.slice(0, 100), token }, "[DGHG] extracted creds");

  if (!passMd5Path || !token) {
    logger.error({ hasPassMd5: !!passMd5Path, hasToken: !!token }, "[DGHG] Step 2 FAILED");
    return null;
  }

  // Step 3: Call pass_md5 to get CDN URL
  const urlObj = new URL(embedUrl);
  const passMd5Url = `https://${urlObj.hostname}/pass_md5/${passMd5Path}`;

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
    logger.error({ error: e.message, status: e.response?.status }, "[DGHG] Step 3 FAILED");
    return null;
  }

  if (!cdnBaseUrl || !cdnBaseUrl.startsWith("http")) {
    logger.error({ cdnBase: cdnBaseUrl?.slice(0, 100) }, "[DGHG] Step 3 FAILED — invalid CDN URL");
    return null;
  }

  // Step 4: Build final URL
  const expiry = Date.now();
  const finalUrl = `${cdnBaseUrl}?token=${token}&expiry=${expiry}`;
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
