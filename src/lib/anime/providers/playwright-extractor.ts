/**
 * Playwright-based headless browser extractor.
 *
 * Used for the Byse CDN (weneverbeenfree.com / myvidplay.com).
 *
 * Authentication flow:
 *   1. GET  /api/videos/{code}/embed/details  — requires Referer: aniwaves.ru
 *   2. POST /api/videos/access/challenge      — browser JS signs a nonce
 *   3. POST /api/videos/access/attest         — returns JWT token
 *   4. POST /api/videos/{code}/embed/playback — requires Origin: aniwaves.ru (domain whitelist)
 *                                               returns AES-256-GCM encrypted HLS URL
 *
 * The browser computes the attest signature. The playback endpoint rejects
 * any Origin not in the whitelist. We can't override `Origin` via Playwright's
 * extraHTTPHeaders for same-origin XHR; instead we:
 *   a. Set context-level Referer: aniwaves.ru so embed/details returns 200
 *   b. Intercept the /embed/playback POST via page.route()
 *   c. Re-issue the same request from Node.js with Origin: aniwaves.ru
 *   d. Return the 200 response to the browser via route.fulfill()
 *   e. The browser decrypts AES-256-GCM → requests the m3u8
 *   f. We intercept and return the m3u8 URL
 */
import https from "https";
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

function httpsPost(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const buf = Buffer.from(body);
    const opts: https.RequestOptions = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      headers: { ...headers, "Content-Length": buf.byteLength },
    };
    const req = https.request(opts, (res) => {
      const respHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v) respHeaders[k] = Array.isArray(v) ? v[0] : v;
      }
      let data = "";
      res.on("data", (c: Buffer) => { data += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data, headers: respHeaders }));
    });
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

export async function extractViaPlaywright(
  embedUrl: string,
  providerName: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  const autoplayUrl = forceAutoplay(embedUrl);

  logger.info(
    { embedUrl: autoplayUrl.slice(0, 90), providerName },
    "[Playwright] launching headless Chromium (Byse CDN extractor)"
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
      permissions: ["camera", "microphone"],
      // Set Referer to aniwaves.ru at context level.
      // This makes the /embed/details call pass the domain whitelist check.
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

    // ── Intercept /embed/playback to fix Origin whitelist bypass ────────────────
    // The Byse CDN whitelist-checks Origin. Browsers enforce the correct same-site
    // Origin and won't let JS override it. We intercept the POST, re-issue it from
    // Node.js with Origin: aniwaves.ru, and fulfill the route with the 200 payload.
    // The browser then decrypts the AES-256-GCM response and requests the m3u8.
    await page.route("**/embed/playback**", async (route) => {
      const reqBody = route.request().postData() ?? "{}";
      const reqUrl = route.request().url();

      logger.info(
        { url: reqUrl.slice(0, 90) },
        "[Playwright] intercepting /embed/playback — re-issuing with aniwaves.ru Origin"
      );

      try {
        const resp = await httpsPost(reqUrl, {
          "User-Agent": UA,
          "Referer": ANIWAVES_REFERER,
          "Origin": ANIWAVES_ORIGIN,
          "Content-Type": "application/json",
          "Accept": "application/json",
        }, reqBody);

        logger.info(
          { status: resp.status, url: reqUrl.slice(0, 90) },
          "[Playwright] /embed/playback direct HTTP response"
        );

        await route.fulfill({
          status: resp.status,
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "access-control-allow-credentials": "true",
          },
          body: resp.body,
        });
      } catch (err) {
        logger.warn(
          { error: (err as Error).message },
          "[Playwright] failed to re-issue /embed/playback — falling back to continue"
        );
        await route.continue();
      }
    });

    // ── Intercept network to capture m3u8 ────────────────────────────────────
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes(".m3u8")) {
        logger.info({ url: url.slice(0, 130) }, "[Playwright] ✓ m3u8 request intercepted");
        if (!m3u8Urls.includes(url)) m3u8Urls.push(url);
      }
      if (url.includes(".vtt") || url.includes(".srt")) {
        const label = (() => {
          try { return new URL(url).searchParams.get("label") ?? "unknown"; } catch { return "unknown"; }
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
        logger.info({ url: url.slice(0, 130) }, "[Playwright] ✓ m3u8 response intercepted");
        m3u8Urls.push(url);
        return;
      }
      const ct = resp.headers()["content-type"] ?? "";
      if (ct.includes("application/json") && m3u8Urls.length === 0) {
        try {
          const text = await resp.text();
          if (text.includes(".m3u8")) {
            const match = text.match(/https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/);
            if (match) {
              logger.info({ url: match[0].slice(0, 130) }, "[Playwright] ✓ m3u8 found in JSON response");
              if (!m3u8Urls.includes(match[0])) m3u8Urls.push(match[0]);
            }
          }
        } catch {
          // ignore
        }
      }
    });

    const waitForM3u8 = (timeoutMs: number): Promise<void> =>
      new Promise((resolve) => {
        const iv = setInterval(() => {
          if (m3u8Urls.length > 0) { clearInterval(iv); resolve(); }
        }, 200);
        setTimeout(() => { clearInterval(iv); resolve(); }, timeoutMs);
      });

    logger.info("[Playwright] navigating to embed page");
    await page
      .goto(autoplayUrl, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT_MS })
      .catch((err: Error) => {
        logger.warn({ error: err.message }, "[Playwright] page.goto errored — continuing");
      });

    // Wait for m3u8 — the playback intercept + browser decryption takes ~8-12s
    await waitForM3u8(M3U8_TIMEOUT_MS);

    if (m3u8Urls.length === 0) {
      const pageTitle = await page.title().catch(() => "unknown");
      const pageUrl = page.url();
      logger.error(
        { embedUrl: autoplayUrl.slice(0, 90), pageTitle, pageUrl },
        "[Playwright] no m3u8 intercepted — page may be blocked or video not found"
      );
      return null;
    }

    const m3u8 =
      m3u8Urls.find((u) => u.includes("master")) ??
      m3u8Urls.find((u) => !u.includes("segment") && !u.includes("chunk") && !u.includes(".ts?")) ??
      m3u8Urls[0];

    logger.info(
      { m3u8: m3u8.slice(0, 130), candidates: m3u8Urls.length },
      "[Playwright] ✓ extraction SUCCESS"
    );

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
      provider: providerName,
      m3u8,
      subtitles,
      thumbnails: thumbnailUrl,
      intro,
      outro,
    };
  } catch (err) {
    logger.error(
      { error: (err as Error).message, embedUrl: embedUrl.slice(0, 90) },
      "[Playwright] fatal error"
    );
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      logger.debug("[Playwright] browser closed");
    }
  }
}
