/**
 * DGHG / PlayMogo / DoodStream provider extractor.
 *
 * The embed page (myvidplay.com → playmogo.com / doodstream.com) is protected
 * by Cloudflare Turnstile. The flow:
 *
 *   1. Page loads with a play button (.captcha_l) and Turnstile hidden
 *   2. User clicks play → Turnstile challenge renders
 *   3. Turnstile solves → callback fires → GET /dood?op=validate&gc_response=...
 *   4. /dood endpoint returns JSON with the stream URL
 *
 * Strategy: Use Playwright to click the play button, wait for Turnstile to be
 * solved by the browser, intercept the /dood response to get the stream URL.
 */
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime, Subtitle } from "../types.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ANIWAVES_REFERER = "https://aniwaves.ru/";

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

export async function extractDghg(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  logger.info({ embedUrl: embedUrl.slice(0, 100) }, "[DGHG] starting Playwright extraction");

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
      ignoreHTTPSErors: true,
      extraHTTPHeaders: {
        Referer: ANIWAVES_REFERER,
      },
    });

    // Stealth: mask headless browser fingerprints
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      // @ts-ignore
      window.chrome = { runtime: {} };
    });

    const page = await context.newPage();

    let streamUrl: string | null = null;

    // Intercept the /dood endpoint response which contains the stream URL
    page.on("response", async (resp) => {
      const url = resp.url();
      if (url.includes("/dood?op=validate") || url.includes("/dood?")) {
        logger.info({ url: url.slice(0, 120) }, "[DGHG] /dood response intercepted");
        try {
          const text = await resp.text();
          logger.debug({ body: text.slice(0, 300) }, "[DGHG] /dood response body");
          // The response might be a direct URL or JSON
          const trimmed = text.trim();
          if (trimmed.startsWith("http") && (trimmed.includes(".m3u8") || trimmed.includes(".mp4") || trimmed.includes("stream"))) {
            streamUrl = trimmed;
            logger.info({ streamUrl: streamUrl.slice(0, 120) }, "[DGHG] got stream URL from /dood");
          } else {
            // Try to parse as JSON
            try {
              const json = JSON.parse(trimmed);
              const possibleUrl = json.file || json.url || json.link || json.src || json.stream || JSON.stringify(json);
              if (possibleUrl && possibleUrl.startsWith("http")) {
                streamUrl = possibleUrl;
                logger.info({ streamUrl: streamUrl.slice(0, 120) }, "[DGHG] got stream URL from /dood JSON");
              }
            } catch {
              // Not JSON, might be a direct URL with different format
              if (trimmed.startsWith("http")) {
                streamUrl = trimmed;
              }
            }
          }
        } catch (e) {
          logger.warn({ error: (e as Error).message }, "[DGHG] failed to parse /dood response");
        }
      }

      // Also check for any m3u8 in any response
      if (!streamUrl) {
        const ct = resp.headers()["content-type"] ?? "";
        if (ct.includes("application/json")) {
          try {
            const text = await resp.text();
            if (text.includes(".m3u8") || text.includes(".mp4")) {
              const match = text.match(/https?:\/\/[^\s"'\\]+\.(?:m3u8|mp4)[^\s"'\\]*/);
              if (match && !streamUrl) {
                streamUrl = match[0];
                logger.info({ streamUrl: streamUrl.slice(0, 120) }, "[DGHG] got stream URL from JSON response");
              }
            }
          } catch { /* ignore */ }
        }
      }
    });

    // Also intercept network requests for m3u8
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes(".m3u8") && !streamUrl) {
        streamUrl = url;
        logger.info({ url: url.slice(0, 130) }, "[DGHG] m3u8 request intercepted");
      }
    });

    logger.info("[DGHG] navigating to embed page");
    await page
      .goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
      .catch((err: Error) => {
        logger.warn({ error: err.message }, "[DGHG] page.goto error, continuing");
      });

    // Wait for page to fully load and Turnstile to initialize
    await page.waitForTimeout(3000);

    // Click the play button to trigger the Turnstile challenge
    logger.info("[DGHG] clicking play button to trigger Turnstile");
    try {
      await page.click(".captcha_l", { timeout: 5000 });
    } catch (e) {
      // Try alternative selectors
      try {
        await page.click(".vjs-big-play-button", { timeout: 5000 });
      } catch (e2) {
        // Try pressing Enter/clicking the video player area
        try {
          await page.click("#video_player", { timeout: 5000 });
        } catch (e3) {
          logger.warn("[DGHG] could not find play button, trying keyboard");
          await page.keyboard.press("Enter").catch(() => {});
        }
      }
    }

    // Wait for Turnstile to solve and /dood callback to fire
    logger.info("[DGHG] waiting for Turnstile + /dood callback (up to 45s)");

    const waitForStream = (timeoutMs: number): Promise<void> =>
      new Promise((resolve) => {
        const iv = setInterval(() => {
          if (streamUrl) { clearInterval(iv); resolve(); }
        }, 500);
        setTimeout(() => { clearInterval(iv); resolve(); }, timeoutMs);
      });

    await waitForStream(45000);

    if (!streamUrl) {
      const pageTitle = await page.title().catch(() => "unknown");
      const html = await page.content().catch(() => "");
      logger.error(
        { embedUrl: embedUrl.slice(0, 90), pageTitle, htmlLen: html.length },
        "[DGHG] no stream URL extracted — Turnstile may have blocked the browser"
      );
      return null;
    }

    logger.info({ streamUrl: streamUrl.slice(0, 130) }, "[DGHG] extraction SUCCESS");

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
      m3u8: streamUrl,
      subtitles: [],
      thumbnails: null,
      intro,
      outro,
    };
  } catch (err) {
    logger.error({ error: (err as Error).message }, "[DGHG] fatal error");
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

export { isPlaymogoHost };
