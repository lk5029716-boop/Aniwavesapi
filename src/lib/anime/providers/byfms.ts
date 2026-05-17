/**
 * BYFMS (WeneverBeenFree / myvidplay.com) extractor.
 *
 * Uses headless Chromium via Playwright because the CDN uses fully obfuscated
 * JavaScript that computes the HLS URL at runtime. We intercept the m3u8
 * network request that the page makes.
 */
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime, Subtitle } from "../types.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ANIWAVES_REFERER = "https://aniwaves.ru/";
const ANIWAVES_ORIGIN = "https://aniwaves.ru";

const M3U8_TIMEOUT_MS = 30_000;
const PAGE_LOAD_TIMEOUT_MS = 20_000;

function forceAutoplay(url: string): string {
  return url
    .replace(/autoPlay=0/gi, "autoPlay=1")
    .replace(/autoplay=0/gi, "autoplay=1");
}

export async function extractByfms(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  const autoplayUrl = forceAutoplay(embedUrl);

  logger.info(
    { embedUrl: autoplayUrl.slice(0, 90) },
    "[BYFMS] launching headless Chromium"
  );

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
        "--disable-software-rasterizer",
        "--disable-extensions",
        "--no-first-run",
        "--no-zygote",
        "--disable-blink-features=AutomationControlled",
        "--autoplay-policy=no-user-gesture-required",
        "--allow-running-insecure-content",
      ],
    });

    const context = await browser.newContext({
      userAgent: UA,
      javaScriptEnabled: true,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        Referer: ANIWAVES_REFERER,
        Origin: ANIWAVES_ORIGIN,
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
    const subtitleUrls: { url: string; label: string }[] = [];
    let thumbnailUrl: string | null = null;

    // Intercept network to capture m3u8
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes(".m3u8")) {
        logger.info({ url: url.slice(0, 130) }, "[BYFMS] m3u8 request intercepted");
        if (!m3u8Urls.includes(url)) m3u8Urls.push(url);
      }
      if (url.includes(".vtt") || url.includes(".srt")) {
        const label = (() => {
          try { return new URL(url).searchParams.get("label") ?? "unknown"; }
          catch { return "unknown"; }
        })();
        subtitleUrls.push({ url, label });
      }
      if ((url.includes("thumbnail") || url.includes("sprite") || url.includes("preview")) && !thumbnailUrl) {
        thumbnailUrl = url;
      }
    });

    page.on("response", async (resp) => {
      const url = resp.url();
      if (url.includes(".m3u8") && !m3u8Urls.includes(url)) {
        m3u8Urls.push(url);
        return;
      }
      const ct = resp.headers()["content-type"] ?? "";
      if (ct.includes("application/json") && m3u8Urls.length === 0) {
        try {
          const text = await resp.text();
          if (text.includes(".m3u8")) {
            const match = text.match(/https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/);
            if (match && !m3u8Urls.includes(match[0])) {
              m3u8Urls.push(match[0]);
            }
          }
        } catch { /* ignore */ }
      }
    });

    const waitForM3u8 = (timeoutMs: number): Promise<void> =>
      new Promise((resolve) => {
        const iv = setInterval(() => {
          if (m3u8Urls.length > 0) { clearInterval(iv); resolve(); }
        }, 200);
        setTimeout(() => { clearInterval(iv); resolve(); }, timeoutMs);
      });

    logger.info("[BYFMS] navigating to embed page");
    await page
      .goto(autoplayUrl, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT_MS })
      .catch((err: Error) => {
        logger.warn({ error: err.message }, "[BYFMS] page.goto error, continuing");
      });

    await waitForM3u8(M3U8_TIMEOUT_MS);

    if (m3u8Urls.length === 0) {
      logger.error("[BYFMS] no m3u8 intercepted");
      return null;
    }

    const m3u8 =
      m3u8Urls.find((u) => u.includes("master")) ??
      m3u8Urls.find((u) => !u.includes("segment") && !u.includes("chunk") && !u.includes(".ts?")) ??
      m3u8Urls[0];

    logger.info({ m3u8: m3u8.slice(0, 130) }, "[BYFMS] extraction SUCCESS");

    let intro: SkipTime | null = null;
    let outro: SkipTime | null = null;
    if (skipData?.intro && (skipData.intro[0] !== 0 || skipData.intro[1] !== 0)) {
      intro = { start: skipData.intro[0], end: skipData.intro[1] };
    }
    if (skipData?.outro && (skipData.outro[0] !== 0 || skipData.outro[1] !== 0)) {
      outro = { start: skipData.outro[0], end: skipData.outro[1] };
    }

    const subtitles: Subtitle[] = subtitleUrls.map((s, i) => ({
      lang: `track-${i}`,
      label: s.label,
      url: s.url,
    }));

    return {
      type: "direct",
      provider: "byfms",
      m3u8,
      subtitles,
      thumbnails: thumbnailUrl,
      intro,
      outro,
    };
  } catch (err) {
    logger.error({ error: (err as Error).message }, "[BYFMS] fatal error");
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

export function isByfmsHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      host.includes("weneverbeenfree") ||
      host.includes("wnbf") ||
      host.includes("myvidplay") ||
      host.includes("animefever")
    );
  } catch {
    return false;
  }
}
