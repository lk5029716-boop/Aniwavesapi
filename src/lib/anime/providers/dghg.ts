/**
 * DGHG (DoodStream / PlayMogo / myvidplay) extractor.
 *
 * Uses Playwright headless Chromium (already installed on Render) to:
 * 1. Load the myvidplay.com/e/<key> page (Chrome passes CF TLS check)
 * 2. Intercept network requests to find /pass_md5/... or .m3u8 URLs
 * 3. Return the final m3u8 stream URL
 *
 * No Python/curl_cffi needed — Playwright's bundled Chromium handles
 * Cloudflare fingerprinting automatically.
 */

import { logger } from "../../logger.js";
import type { StreamSource, SkipTime } from "../types.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function isPlayMogoHost(url: string): boolean {
  try {
    return new URL(url).hostname.includes("playmogo");
  } catch {
    return false;
  }
}

export function isDghgEmbedUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.includes("myvidplay") || host.includes("playmogo");
  } catch {
    return false;
  }
}

export async function extractDghg(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  const targetUrl = isPlayMogoHost(embedUrl) ? embedUrl : embedUrl;

  logger.info(
    { embedUrl: embedUrl.slice(0, 100) },
    "[DGHG] starting Playwright extraction"
  );

  let browser: import("playwright-core").Browser | null = null;

  try {
    const { chromium } = await import("playwright-core");

    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--disable-blink-features=AutomationControlled",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });

    const context = await browser.newContext({
      userAgent: UA,
      javaScriptEnabled: true,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://aniwaves.ru/",
      },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      // @ts-ignore
      window.chrome = { runtime: {} };
    });

    const page = await context.newPage();

    const m3u8Urls: string[] = [];
    const passMd5Urls: string[] = [];

    // Intercept all network requests
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes(".m3u8")) {
        logger.info({ url: url.slice(0, 130) }, "[DGHG] m3u8 request intercepted");
        if (!m3u8Urls.includes(url)) m3u8Urls.push(url);
      }
      if (url.includes("/pass_md5/")) {
        logger.info({ url: url.slice(0, 130) }, "[DGHG] pass_md5 request intercepted");
        if (!passMd5Urls.includes(url)) passMd5Urls.push(url);
      }
    });

    page.on("response", async (resp) => {
      const url = resp.url();
      if (url.includes(".m3u8") && !m3u8Urls.includes(url)) {
        logger.info({ url: url.slice(0, 130) }, "[DGHG] m3u8 response intercepted");
        m3u8Urls.push(url);
      }
    });

    // Navigate to the embed URL
    logger.info({ url: targetUrl.slice(0, 100) }, "[DGHG] navigating to embed URL");
    await page.goto(targetUrl, {
      waitUntil: "networkidle",
      timeout: 20_000,
    });

    // Wait a bit for any lazy-loaded requests
    await page.waitForTimeout(3000);

    // Also try to extract pass_md5 from page HTML
    const pageContent = await page.content();
    const passMd5Match = pageContent.match(/\/pass_md5\/([a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)/);
    if (passMd5Match) {
      const passMd5Path = passMd5Match[0];
      const origin = new URL(targetUrl).origin;
      const passMd5Url = origin + passMd5Path;
      if (!passMd5Urls.includes(passMd5Url)) {
        passMd5Urls.push(passMd5Url);
        logger.info({ passMd5Url: passMd5Url.slice(0, 130) }, "[DGHG] pass_md5 found in HTML");
      }
    }

    await browser.close();
    browser = null;

    // If we got m3u8 URLs directly, return the first one
    if (m3u8Urls.length > 0) {
      const m3u8 = m3u8Urls[0];
      logger.info({ m3u8: m3u8.slice(0, 100) }, "[DGHG] m3u8 found via interception");
      await browser.close();
      browser = null;
      return buildResult(m3u8, embedUrl, skipData);
    }

    // If we found pass_md5, fetch it from within the browser context
    // (inherits cookies + TLS fingerprint — bypasses CF)
    if (passMd5Urls.length > 0) {
      const passMd5Url = passMd5Urls[0];
      logger.info({ passMd5Url: passMd5Url.slice(0, 130) }, "[DGHG] fetching pass_md5 via browser context");

      const baseUrl = await page.evaluate(async (url: string) => {
        try {
          const r = await fetch(url, {
            headers: { Referer: document.location.href },
          });
          const text = await r.text();
          if (text.trim().startsWith("http")) {
            const lastSlash = text.trim().lastIndexOf("/");
            return lastSlash > 0 ? text.trim().slice(0, lastSlash) : text.trim();
          }
          return null;
        } catch {
          return null;
        }
      }, passMd5Url);

      if (baseUrl) {
        const m3u8 = baseUrl + "/index-f1-v1-a1.m3u8";
        logger.info({ m3u8: m3u8.slice(0, 100) }, "[DGHG] m3u8 constructed from pass_md5");
        await browser.close();
        browser = null;
        return buildResult(m3u8, embedUrl, skipData);
      }
    }

    await browser.close();
    browser = null;

  } catch (err) {
    logger.error({ error: (err as Error).message }, "[DGHG] extraction error");
    if (browser) {
      try { await browser.close(); } catch {}
    }
    return null;
  }
}

function buildResult(
  m3u8: string,
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): StreamSource {
  let intro: SkipTime | null = null;
  let outro: SkipTime | null = null;
  if (skipData?.intro && (skipData.intro[0] !== 0 || skipData.intro[1] !== 0)) {
    intro = { start: skipData.intro[0], end: skipData.intro[1] };
  }
  if (skipData?.outro && (skipData.outro[0] !== 0 || skipData.outro[1] !== 0)) {
    outro = { start: skipData.outro[0], end: skipData.outro[1] };
  }

  return {
    type: "direct",
    provider: "dghg",
    m3u8,
    subtitles: [],
    thumbnails: null,
    intro,
    outro,
  };
}

export function isDghgServer(serverName: string): boolean {
  const n = serverName.toLowerCase();
  return n.includes("dghg") || n.includes("dood") || n.includes("playmogo");
}
