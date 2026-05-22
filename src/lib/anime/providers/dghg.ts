/**
 * DGHG / PlayMogo / DoodStream provider extractor.
 *
 * The embed page (myvidplay.com → playmogo.com / doodstream.com) is protected
 * by Cloudflare Turnstile. The HTML only contains a Turnstile challenge — the
 * actual video player JS (with pass_md5 / m3u8) only loads AFTER the challenge
 * is solved by a real browser.
 *
 * Strategy: Use Playwright headless Chromium to load the page, let the browser
 * solve the Turnstile challenge, then intercept the m3u8 network request that
 * the video player makes. This is the same approach used by the BYFMS extractor.
 */
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime, Subtitle } from "../types.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ANIWAVES_REFERER = "https://aniwaves.ru/";
const ANIWAVES_ORIGIN = "https://aniwaves.ru";

const M3U8_TIMEOUT_MS = 45_000;  // Turnstile can take ~30s to solve
const PAGE_LOAD_TIMEOUT_MS = 30_000;

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
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        Referer: ANIWAVES_REFERER,
        Origin: ANIWAVES_ORIGIN,
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

    const m3u8Urls: string[] = [];
    const subtitleUrls: { url: string; label: string }[] = [];
    let thumbnailUrl: string | null = null;

    // Intercept network requests to capture m3u8 URLs
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes(".m3u8")) {
        logger.info({ url: url.slice(0, 130) }, "[DGHG] m3u8 request intercepted");
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

    // Also check responses for m3u8 URLs embedded in JSON
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

    // Wait for m3u8 with a long timeout (Turnstile challenge takes time)
    const waitForM3u8 = (timeoutMs: number): Promise<void> =>
      new Promise((resolve) => {
        const iv = setInterval(() => {
          if (m3u8Urls.length > 0) { clearInterval(iv); resolve(); }
        }, 500);
        setTimeout(() => { clearInterval(iv); resolve(); }, timeoutMs);
      });

    logger.info("[DGHG] navigating to embed page (waiting for Turnstile + video player JS)");
    await page
      .goto(embedUrl, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT_MS })
      .catch((err: Error) => {
        logger.warn({ error: err.message }, "[DGHG] page.goto error, continuing");
      });

    // Wait for the Turnstile challenge to be solved and video player to load m3u8
    await waitForM3u8(M3U8_TIMEOUT_MS);

    if (m3u8Urls.length === 0) {
      // Fallback: try to extract pass_md5 from HTML (works if Turnstile already solved)
      logger.warn("[DGHG] no m3u8 intercepted, trying pass_md5 fallback");
      const html = await page.content();
      const passMd5Match = html.match(/\$\.get\s*\(\s*['"]\/pass_md5\/([^'"]+)['"]\s*,/);
      if (passMd5Match) {
        logger.info("[DGHG] found pass_md5 in HTML, using direct extraction");
        // Could implement direct pass_md5 extraction here as fallback
      }

      const pageTitle = await page.title().catch(() => "unknown");
      logger.error(
        { embedUrl: embedUrl.slice(0, 90), pageTitle, htmlLen: html.length },
        "[DGHG] no m3u8 intercepted — Turnstile may have blocked the browser"
      );
      return null;
    }

    const m3u8 =
      m3u8Urls.find((u) => u.includes("master")) ??
      m3u8Urls.find((u) => !u.includes("segment") && !u.includes("chunk") && !u.includes(".ts?")) ??
      m3u8Urls[0];

    logger.info({ m3u8: m3u8.slice(0, 130), candidates: m3u8Urls.length }, "[DGHG] extraction SUCCESS");

    let intro: SkipTime | null = null;
    let outro: SkipTime | null = null;
    if (skipData?.intro?.[1] && skipData.intro[1] > 0) {
      intro = { start: skipData.intro[0], end: skipData.intro[1] };
    }
    if (skipData?.outro?.[1] && skipData.outro[1] > 0) {
      outro = { start: skipData.outro[0], end: skipData.outro[1] };
    }

    const subtitles: Subtitle[] = subtitleUrls.map((s, i) => ({
      lang: `track-${i}`,
      label: s.label,
      url: s.url,
    }));

    return {
      type: "direct",
      provider: "dghg",
      m3u8,
      subtitles,
      thumbnails: thumbnailUrl,
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
