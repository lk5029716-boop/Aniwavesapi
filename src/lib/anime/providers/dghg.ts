/**
 * DGHG (DoodStream / PlayMogo / myvidplay) extractor.
 *
 * PlayMogo / myvidplay sit behind an ACTIVE Cloudflare challenge (Turnstile /
 * "Just a moment..."). A server-side curl_cffi request re-triggers that
 * challenge every time, so we CANNOT scrape it with a separate HTTP call.
 *
 * Instead we do the ENTIRE extraction inside a real headless browser:
 *   1. Launch chromium, navigate to the embed (CF clears in-context).
 *   2. Intercept the /pass_md5/<hash>/<token> XHR the player fires once the
 *      challenge is solved.
 *   3. Fetch that endpoint IN the same cleared context -> it returns the base
 *      CDN m3u8 URL.
 *   4. Return that m3u8.
 *
 * This is reliable because the browser context is already CF-cleared; no second
 * request ever hits Cloudflare.
 */

import { chromium, type Browser, type BrowserContext } from "playwright";
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime } from "../types.js";

export function isDghgEmbedUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.includes("myvidplay") || host.includes("playmogo");
  } catch {
    return false;
  }
}

export function isDghgServer(serverName: string): boolean {
  const n = serverName.toLowerCase();
  return n.includes("dghg") || n.includes("dood") || n.includes("playmogo");
}

/**
 * Pull the first http(s) URL (preferably an .m3u8) out of a /pass_md5/ response
 * body. Avoids regex quoting pitfalls by scanning for the scheme and stopping
 * at the first whitespace/quote.
 */
function extractM3u8Url(body: string): string | null {
  const candidates: string[] = [];
  let idx = 0;
  while (true) {
    const start = body.indexOf("http", idx);
    if (start === -1) break;
    let end = start;
    while (end < body.length) {
      const ch = body[end];
      if (ch === '"' || ch === "'" || ch === " " || ch === "\n" || ch === "\r" || ch === ")" || ch === ">" || ch === "<") break;
      end++;
    }
    if (end > start) candidates.push(body.slice(start, end));
    idx = end + 1;
  }
  if (candidates.length === 0) return null;
  // Prefer an actual .m3u8 URL, then a known CDN host, then any http(s) URL.
  const m3u8 = candidates.find((c) => /\.m3u8/i.test(c));
  const cdn = candidates.find((c) => /cloudatacdn\.com|cdn|\.m3u8/i.test(c));
  const clean = candidates.find((c) => !/http-equiv|w3\.org|schema\.org/i.test(c));
  return m3u8 ?? cdn ?? clean ?? null;
}

export async function extractDghg(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] },
  _proxyUrl?: string | null
): Promise<StreamSource | null> {
  logger.info({ embedUrl: embedUrl.slice(0, 100) }, "[DGHG] start");

  const host = (() => { try { return new URL(embedUrl).hostname; } catch { return ""; } })();
  if (!host.includes("myvidplay") && !host.includes("playmogo")) {
    logger.warn({ embedUrl }, "[DGHG] not a dghg host, skipping");
    return null;
  }

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      // Stealth: Render's chromium is flagged as automation (navigator.webdriver,
      // datacenter IP), so playmogo's player never fires /pass_md5/. These args
      // make headless chromium look like a real user.
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
        "--headless=new",
      ],
    });
    const ctx: BrowserContext = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
      locale: "en-US",
      timezoneId: "America/New_York",
    });
    const page = await ctx.newPage();
    // Spoof webdriver + automation artifacts before any script runs.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      const navAny = navigator as any;
      if (!navAny.chrome) {
        Object.defineProperty(navigator, "chrome", { get: () => ({ runtime: {} }), configurable: true });
      }
      const permDesc = Object.getOwnPropertyDescriptor(navigator, "permissions");
      if (permDesc) {
        Object.defineProperty(navigator, "permissions", {
          get: () => ({
            query: (p: { name: string }) =>
              p.name === "notifications"
                ? Promise.resolve({ state: "prompt", addEventListener() {}, removeEventListener() {} })
                : (permDesc.get as any).call(navigator).query(p),
          }),
          configurable: true,
        });
      }
    });

    let m3u8: string | null = null;
    let passMd5Url: string | null = null;
    // Backup listener: just RECORD the pass_md5 URL (never read its body -- the
    // response body can hang/be consumed by the player's chaotic post-CF
    // redirects). We fetch it separately via evaluate below.
    page.on("response", (resp) => {
      if (/\/pass_md5\//i.test(resp.url())) passMd5Url = resp.url();
    });

    // Retry the page load a few times: CF's challenge is probabilistic, but the
    // first paint usually clears and the player fires /pass_md5/ immediately.
    // We capture that response DETERMINISTICALLY with waitForResponse (the bare
    // event listener missed it on some headless setups) and only grab its URL.
    for (let attempt = 1; attempt <= 3 && !m3u8; attempt++) {
      try {
        // "commit" returns as soon as the server responds -- Cloudflare's
        // challenge page otherwise never fires domcontentloaded (it keeps
        // reloading), which made goto hang. waitForResponse below catches the
        // real /pass_md5/ XHR once CF clears.
        await page.goto(embedUrl, { waitUntil: "commit", timeout: 25000 });
      } catch (navErr) {
        logger.warn({ error: String(navErr).slice(0, 100) }, "[DGHG] goto error, retrying");
      }

      // Actively wait for the pass_md5 response, then read ITS body directly
      // (re-fetching via evaluate returns a different/garbage body).
      const resp = await page
        .waitForResponse((r) => /\/pass_md5\//i.test(r.url()), { timeout: 20000 })
        .catch(() => null);
      if (resp) {
        passMd5Url = resp.url();
        try {
          const body = await resp.text();
          const hit = extractM3u8Url(body);
          if (hit) m3u8 = hit;
        } catch (e) {
          logger.warn({ error: String(e).slice(0, 120) }, "[DGHG] pass_md5 body read failed");
        }
      }

      // Fallback: read the <video>/<source> src straight from the DOM.
      if (!m3u8) {
        try {
          const dom = await page.evaluate(() => {
            const v = document.querySelector("video");
            const s = document.querySelector("source");
            const a = document.querySelector("a[href*='.m3u8']");
            return { v: v?.getAttribute("src") || null, s: s?.getAttribute("src") || null, a: a?.getAttribute("href") || null };
          });
          const cand = dom.v || dom.s || dom.a;
          if (cand && cand.includes(".m3u8")) m3u8 = cand;
        } catch { /* ignore */ }
      }

      const cleared = (await ctx.cookies()).some((c) => c.name === "cf_clearance");
      logger.info({ attempt, cfClearance: cleared, passMd5: !!passMd5Url, m3u8: !!m3u8 }, "[DGHG] load attempt");
    }

    if (!m3u8) {
      logger.warn({ passMd5: !!passMd5Url }, "[DGHG] could not extract m3u8 (CF challenge not cleared, pass_md5 XHR missed, or no <video> src)");
      return null;
    }

    logger.info({ m3u8: m3u8.slice(0, 80) }, "[DGHG] OK");

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
  } catch (e) {
    logger.warn({ error: String(e).slice(0, 200) }, "[DGHG] exception, skipping");
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}
