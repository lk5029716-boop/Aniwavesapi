/**
 * DGHG / PlayMogo / DoodStream provider extractor v3.
 *
 * Uses Playwright with enhanced stealth to solve Cloudflare Turnstile,
 * then extracts pass_md5 from the post-reload HTML.
 *
 * Key insight: the headless Chromium on Render CAN solve Cloudflare's
 * managed challenge (we see it in the debug endpoint), but Turnstile
 * requires additional checks. We add fingerprint randomization and
 * longer wait times.
 */
import axios from "axios";
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime } from "../types.js";

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
  const videoId = urlObj.pathname.split("/").pop() || "";

  logger.info({ embedUrl: embedUrl.slice(0, 100) }, "[DGHG] starting extraction v3");

  let browser: import("playwright").Browser | null = null;

  try {
    const pw = await import("playwright");
    const chromium = pw.chromium;

    // Generate a realistic fingerprint
    const screens = [
      { w: 1920, h: 1080 },
      { w: 1366, h: 768 },
      { w: 1536, h: 864 },
    ];
    const screen = screens[Math.floor(Math.random() * screens.length)];
    const UAs = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    ];
    const UA = UAs[Math.floor(Math.random() * UAs.length)];

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
        `--window-size=${screen.w},${screen.h}`,
      ],
    });

    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: screen.w, height: screen.h },
      javaScriptEnabled: true,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        Referer: "https://aniwaves.ru/",
      },
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    // Enhanced stealth
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "platform", { get: () => "Win32" });
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
      // @ts-ignore
      window.chrome = { runtime: {}, loadTimes: function() {}, csi: function() {} };
      // Override the debugger detection
      const originalQuery = window.navigator.permissions?.query;
      if (originalQuery) {
        // @ts-ignore
        window.navigator.permissions.query = (parameters) =>
          parameters.name === "notifications"
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters);
      }
    });

    const page = await context.newPage();

    // Block unnecessary resources to speed up loading
    await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,ico}", (route) => route.abort());
    await page.route("**/beacon/**", (route) => route.abort());
    await page.route("**/analytics/**", (route) => route.abort());

    // Step 1: Navigate to embed page
    logger.info("[DGHG] navigating to embed page");
    const response = await page.goto(embedUrl, {
      waitUntil: "networkidle",
      timeout: 60000,
    }).catch(async () => {
      // If networkidle times out, try domcontentloaded
      return page.goto(embedUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }).catch(() => null);
    });

    logger.info({ status: response?.status(), url: page.url() }, "[DGHG] page loaded");

    // Check for redirect
    const currentUrl = page.url();
    if (currentUrl !== embedUrl) {
      host = new URL(currentUrl).hostname;
    }

    // Wait for Turnstile to load
    await page.waitForTimeout(2000);

    // Step 2: Click the play button
    logger.info("[DGHG] clicking play button");
    const playClicked = await page.evaluate(() => {
      // Try multiple selectors
      const selectors = [".captcha_l", ".vjs-big-play-button", "#video_player button", "button.vjs-big-play-button"];
      for (const sel of selectors) {
        const el = document.querySelector(sel) as HTMLElement;
        if (el) {
          el.click();
          return sel;
        }
      }
      // Try clicking the video player area
      const vp = document.getElementById("video_player");
      if (vp) {
        vp.click();
        return "#video_player";
      }
      return null;
    });

    logger.info({ playClicked }, "[DGHG] play button click result");

    // Step 3: Wait for Turnstile to solve and page to reload with video content
    logger.info("[DGHG] waiting for Turnstile solve + reload (up to 60s)");

    const startTime = Date.now();
    const TIMEOUT = 60000;
    let passMd5Path: string | null = null;
    let lastHtmlLen = 0;

    while (Date.now() - startTime < TIMEOUT) {
      await page.waitForTimeout(3000);
      const elapsed = Date.now() - startTime;

      const html = await page.content().catch(() => "");
      const currentUrl = page.url();
      const htmlLen = html.length;

      // Log progress every 10s
      if (elapsed % 10000 < 3000 && htmlLen !== lastHtmlLen) {
        logger.debug({ elapsed: Math.round(elapsed/1000), htmlLen, url: currentUrl.slice(0,60) }, "[DGHG] waiting...");
        lastHtmlLen = htmlLen;
      }

      // Check 1: pass_md5 found in HTML
      const m = html.match(/\$\.get\s*\(\s*['"]\/pass_md5\/([^'"]+)['"]\s*,/);
      if (m) {
        passMd5Path = m[1];
        logger.info({ passMd5Path, elapsed: Math.round(elapsed/1000) }, "[DGHG] ✓ found pass_md5!");
        break;
      }

      // Check 2: page grew significantly beyond Turnstile gate (6103 bytes)
      if (htmlLen > 7000) {
        const altMatch = html.match(/pass_md5\/([^'"\s,)\]]+)/);
        if (altMatch && !altMatch[0].includes("function")) {
          passMd5Path = altMatch[1];
          logger.info({ passMd5Path, htmlLen, elapsed: Math.round(elapsed/1000) }, "[DGHG] ✓ found pass_md5 (alt)!");
          break;
        }
      }

      // Check 3: URL changed (page reload after Turnstile)
      if (videoId && !currentUrl.includes(videoId)) {
        logger.info({ currentUrl: currentUrl.slice(0,60) }, "[DGHG] URL changed (redirect?), checking HTML");
      }
    }

    if (!passMd5Path) {
      const html = await page.content().catch(() => "");
      const pageTitle = await page.title().catch(() => "unknown");
      logger.error(
        { embedUrl: embedUrl.slice(0, 90), pageTitle, htmlLen: html.length },
        "[DGHG] ✗ Turnstile not solved or pass_md5 not found after 60s"
      );
      return null;
    }

    // Step 4: Extract token and call pass_md5
    const pathParts = passMd5Path.split("/");
    const token = pathParts[pathParts.length - 1];
    if (!token) {
      logger.error("[DGHG] could not extract token");
      return null;
    }

    logger.info({ token: token.slice(0, 20) }, "[DGHG] extracted token");

    const passMd5Url = `https://${host}/pass_md5/${passMd5Path}`;
    logger.info({ url: passMd5Url.slice(0, 80) }, "[DGHG] calling pass_md5");

    let cdnBaseUrl: string;
    try {
      // Use the browser context cookies for the pass_md5 call
      const cookies = await context.cookies();
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");

      const resp = await axios.get(passMd5Url, {
        timeout: 15000,
        headers: {
          "User-Agent": UA,
          Accept: "*/*",
          Referer: `https://${host}/e/${videoId}`,
          Cookie: cookieStr,
        },
        maxRedirects: 5,
      });
      cdnBaseUrl = (resp.data as string).trim();
    } catch (err) {
      const e = err as Error & { response?: { status: number } };
      logger.error({ error: e.message, status: e.response?.status }, "[DGHG] pass_md5 call failed");

      // Try without cookies
      try {
        const resp = await axios.get(passMd5Url, {
          timeout: 15000,
          headers: {
            "User-Agent": UA,
            Accept: "*/*",
            Referer: `https://${host}/e/${videoId}`,
          },
          maxRedirects: 5,
        });
        cdnBaseUrl = (resp.data as string).trim();
      } catch {
        return null;
      }
    }

    if (!cdnBaseUrl || !cdnBaseUrl.startsWith("http")) {
      logger.error({ cdnBase: cdnBaseUrl?.slice(0, 200) }, "[DGHG] invalid CDN URL");
      return null;
    }

    // Step 5: Construct final URL
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let randomSuffix = "";
    for (let i = 0; i < 10; i++) {
      randomSuffix += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const expiry = Date.now();
    const finalUrl = `${cdnBaseUrl}${randomSuffix}?token=${token}&expiry=${expiry}`;

    logger.info({ finalUrl: finalUrl.slice(0, 120) }, "[DGHG] ✓ extraction SUCCESS");

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
