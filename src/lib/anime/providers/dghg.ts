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
async function fetchEmbedPage(embedUrl: string): Promise<{ html: string; debug: Record<string, unknown> } | null> {
  let browser: import("playwright").Browser | null = null;
  const debug: Record<string, unknown> = { embedUrl: embedUrl.slice(0, 100) };

  try {
    const { chromium } = await import("playwright");
    debug.playwrightImported = true;

    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
    debug.browserLaunched = true;

    const context = await browser.newContext({
      userAgent: UA,
      extraHTTPHeaders: {
        Referer: "https://aniwaves.ru/",
      },
    });
    const page = await context.newPage();

    // Try navigation with different wait strategies
    let navResult: "success" | "timeout" | "error" = "error";
    try {
      await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      navResult = "success";
    } catch (navErr) {
      const msg = (navErr as Error).message;
      if (msg.includes("timeout")) {
        navResult = "timeout";
        logger.warn({ embedUrl: embedUrl.slice(0, 80) }, "[DGHG] page.goto timeout — continuing with partial load");
      } else {
        throw navErr;
      }
    }
    debug.navResult = navResult;

    const html = await page.content();
    debug.htmlLength = html.length;
    debug.pageTitle = await page.title().catch(() => "unknown");
    debug.pageUrl = page.url();

    await browser.close();
    debug.browserClosed = true;

    logger.info(debug, "[DGHG] fetchEmbedPage complete");

    return { html, debug };
  } catch (err) {
    const e = err as Error;
    debug.error = e.message;
    debug.stack = e.stack?.split("\n").slice(0, 3).join(" | ");
    logger.error(debug, "[DGHG] Playwright fetch failed");
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

export async function extractDghg(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource & { _dghgDebug?: Record<string, unknown> } | null> {
  const masterDebug: Record<string, unknown> = { embedUrl: embedUrl.slice(0, 100) };
  logger.info({ embedUrl: embedUrl.slice(0, 100) }, "[DGHG] starting extraction");

  // Step 1: Fetch embed page via Playwright
  const result = await fetchEmbedPage(embedUrl);
  if (!result) {
    logger.error({ ...masterDebug, step: 1 }, "[DGHG] Step 1 FAILED — could not fetch embed page");
    return null;
  }

  const { html, debug: fetchDebug } = result;
  masterDebug.fetch = fetchDebug;

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

  masterDebug.passMd5Path = passMd5Path?.slice(0, 100);
  masterDebug.token = token?.slice(0, 30);
  masterDebug.hasPassMd5 = !!passMd5Path;
  masterDebug.hasToken = !!token;

  logger.info(masterDebug, "[DGHG] extracted creds");

  if (!passMd5Path || !token) {
    // Log a snippet of the HTML to help debug
    masterDebug.htmlSnippet = html.slice(0, 500);
    logger.error(masterDebug, "[DGHG] Step 2 FAILED — could not extract pass_md5 path or token");
    return null;
  }

  // Step 3: Call pass_md5 to get CDN URL
  const urlObj = new URL(embedUrl);
  const passMd5Url = `https://${urlObj.hostname}/pass_md5/${passMd5Path}`;
  masterDebug.passMd5Url = passMd5Url.slice(0, 120);

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
    masterDebug.cdnBase = cdnBaseUrl.slice(0, 100);
  } catch (err) {
    const e = err as Error & { response?: { status: number } };
    masterDebug.step3Error = e.message;
    masterDebug.step3Status = e.response?.status;
    logger.error(masterDebug, "[DGHG] Step 3 FAILED");
    return null;
  }

  if (!cdnBaseUrl || !cdnBaseUrl.startsWith("http")) {
    masterDebug.cdnBase = cdnBaseUrl?.slice(0, 100);
    logger.error(masterDebug, "[DGHG] Step 3 FAILED — invalid CDN URL");
    return null;
  }

  // Step 4: Build final URL
  const expiry = Date.now();
  const finalUrl = `${cdnBaseUrl}?token=${token}&expiry=${expiry}`;
  masterDebug.finalUrl = finalUrl.slice(0, 120);
  logger.info(masterDebug, "[DGHG] extraction SUCCESS");

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
    _dghgDebug: masterDebug,
  };
}

export { isPlaymogoHost };
