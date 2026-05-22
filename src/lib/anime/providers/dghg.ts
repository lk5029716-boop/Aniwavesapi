/**
 * DGHG / PlayMogo / DoodStream provider extractor.
 *
 * Flow discovered from page reverse engineering:
 *
 * 1. Page loads with Cloudflare Turnstile gate
 * 2. Click play button (.captcha_l) → renders Turnstile widget
 * 3. Turnstile solved → callback fires: GET /dood?op=validate&gc_response=...
 * 4. /dood validates and sets session → location.reload()
 * 5. After reload, page serves actual video HTML with pass_md5 path
 * 6. Extract pass_md5, call it → get CDN base URL
 * 7. Construct final URL: {cdnUrl}{random10chars}?token={token}&expiry={timestamp}
 *
 * This approach: use Playwright to simulate click+wait for Turnstile,
 * intercept the page reload, then extract pass_md5 from the post-reload HTML.
 */
import axios from "axios";
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime } from "../types.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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
  const urlObj = new URL(embedUrl);
  let host = urlObj.hostname;

  logger.info({ embedUrl: embedUrl.slice(0, 100) }, "[DGHG] starting extraction");

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

    // Step 1: Load the embed page
    logger.info("[DGHG] loading embed page");
    await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e: Error) => {
      logger.warn({ error: e.message }, "[DGHG] goto error");
    });

    // Wait for Turnstile JS to load
    await page.waitForTimeout(3000);

    // Check if we got redirected (myvidplay → playmogo)
    const currentUrl = page.url();
    if (currentUrl !== embedUrl) {
      logger.info({ currentUrl: currentUrl.slice(0, 80) }, "[DGHG] redirected");
      host = new URL(currentUrl).hostname;
    }

    // Step 2: Click the play button to trigger Turnstile
    logger.info("[DGHG] clicking play button to trigger Turnstile");
    let clicked = false;
    try {
      await page.click(".captcha_l", { timeout: 5000 });
      clicked = true;
    } catch {
      try {
        await page.click(".vjs-big-play-button", { timeout: 5000 });
        clicked = true;
      } catch {
        try {
          await page.click("#video_player", { timeout: 5000 });
          clicked = true;
        } catch {
          await page.keyboard.press("Enter").catch(() => {});
        }
      }
    }

    if (!clicked) {
      logger.warn("[DGHG] could not click play button, waiting anyway");
    }

    // Step 3: Wait for Turnstile to solve + page to reload with video content
    // The flow: click → Turnstile → /dood?op=validate → location.reload()
    // After reload, the page should have pass_md5 in HTML
    logger.info("[DGHG] waiting for Turnstile solve + page reload (up to 45s)");

    // Wait for the URL to change (redirect after Turnstile) or for pass_m5 to appear
    const startTime = Date.now();
    const TIMEOUT = 45000;
    let passMd5Path: string | null = null;

    while (Date.now() - startTime < TIMEOUT) {
      await page.waitForTimeout(2000);

      // Check current page HTML for pass_md5
      const html = await page.content().catch(() => "");
      const m = html.match(/\$\.get\s*\(\s*['"]\/pass_md5\/([^'"]+)['"]\s*,/);
      if (m) {
        passMd5Path = m[1];
        logger.info({ passMd5Path }, "[DGHG] found pass_md5 after Turnstile!");
        break;
      }

      // Check if page is still showing Turnstile
      const pageUrl = page.url();
      const hasTurnstile = html.includes("turnstile") || html.includes("cf-challenge");

      if (!hasTurnstile && html.length > 6500) {
        // Page loaded beyond the Turnstile gate (>6103 bytes), might have video content
        // Look for any reference to pass_md5 or video
        const altMatch = html.match(/pass_md5\/([^'"\s,)]+)/);
        if (altMatch) {
          passMd5Path = altMatch[1];
          logger.info({ passMd5Path }, "[DGHG] found pass_md5 (alt pattern)");
          break;
        }
      }

      // Check elapsed
      const elapsed = Date.now() - startTime;
      if (elapsed > 20000 && !passMd5Path) {
        // After 20s, try pressing play again in case the first click didn't register
        try {
          await page.click(".captcha_l", { timeout: 2000 });
        } catch { /* ignore */ }
      }
    }

    if (!passMd5Path) {
      const pageTitle = await page.title().catch(() => "unknown");
      const html = await page.content().catch(() => "");
      logger.error(
        { embedUrl: embedUrl.slice(0, 90), pageTitle, htmlLen: html.length },
        "[DGHG] Turnstile did not solve or pass_md5 not found"
      );
      return null;
    }

    // Step 4: Extract token from pass_md5 path
    const pathParts = passMd5Path.split("/");
    const token = pathParts[pathParts.length - 1];
    if (!token) {
      logger.error("[DGHG] could not extract token from pass_md5 path");
      return null;
    }

    logger.info({ token: token.slice(0, 20) }, "[DGHG] extracted token");

    // Step 5: Call pass_md5 endpoint to get CDN base URL
    const passMd5Url = `https://${host}/pass_md5/${passMd5Path}`;
    logger.info({ url: passMd5Url.slice(0, 80) }, "[DGHG] calling pass_md5 endpoint");

    let cdnBaseUrl: string;
    try {
      const resp = await axios.get(passMd5Url, {
        timeout: 15000,
        headers: {
          "User-Agent": UA,
          Accept: "*/*",
          Referer: `https://${host}/e/` + urlObj.pathname.split("/").pop(),
        },
        maxRedirects: 5,
      });
      cdnBaseUrl = (resp.data as string).trim();
    } catch (err) {
      const e = err as Error & { response?: { status: number } };
      logger.error({ error: e.message, status: e.response?.status }, "[DGHG] pass_md5 request failed");
      return null;
    }

    if (!cdnBaseUrl || !cdnBaseUrl.startsWith("http")) {
      logger.error({ cdnBase: cdnBaseUrl?.slice(0, 200) }, "[DGHG] invalid CDN URL from pass_md5");
      return null;
    }

    logger.info({ cdnBase: cdnBaseUrl.slice(0, 100) }, "[DGHG] got CDN base URL");

    // Step 6: Construct final URL
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
