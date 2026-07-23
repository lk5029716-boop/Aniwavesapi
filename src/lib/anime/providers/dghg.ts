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
  const m3u8 = candidates.find((c) => c.includes(".m3u8"));
  return m3u8 ?? candidates[0];
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
    try {
      browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
      });
    } catch (launchErr) {
      // Surface the real reason (e.g. missing system libs on the host) instead
      // of the generic "CF solve likely failed".
      throw new Error("chromium launch failed: " + String(launchErr).slice(0, 300));
    }
    const ctx: BrowserContext = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });
    const page = await ctx.newPage();

    let passMd5Url: string | null = null;
    let m3u8: string | null = null;
    page.on("response", async (resp) => {
      const u = resp.url();
      if (/\/pass_md5\//i.test(u)) {
        passMd5Url = u;
        try {
          const body = await resp.text();
          const hit = extractM3u8Url(body);
          if (hit) m3u8 = hit;
        } catch { /* body already consumed */ }
      }
    });

    // Retry the page load a few times: CF's challenge is probabilistic, but the
    // first paint usually clears and the player fires /pass_md5/ immediately.
    let cleared = false;
    for (let attempt = 1; attempt <= 3 && !m3u8; attempt++) {
      try {
        await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
      } catch (navErr) {
        logger.warn({ error: String(navErr).slice(0, 100) }, "[DGHG] goto error, retrying");
      }
      // wait for cf_clearance + player XHR (cap 6s per attempt)
      for (let i = 0; i < 6 && !m3u8; i++) {
        await page.waitForTimeout(1000);
      }
      cleared = (await ctx.cookies()).some((c) => c.name === "cf_clearance");
      logger.info({ attempt, cfClearance: cleared, passMd5: !!passMd5Url, m3u8: !!m3u8 }, "[DGHG] load attempt");
    }

    if (!m3u8 && passMd5Url) {
      // Fallback: fetch the pass_md5 endpoint in the cleared context.
      try {
        const r = await page.evaluate(async (url) => {
          const res = await fetch(url, { credentials: "include" });
          return await res.text();
        }, passMd5Url);
        const hit = extractM3u8Url(r);
        if (hit) m3u8 = hit;
      } catch (e) {
        logger.warn({ error: String(e).slice(0, 120) }, "[DGHG] pass_md5 fetch failed");
      }
    }

    if (!m3u8) {
      logger.warn({ cfClearance: cleared, passMd5: !!passMd5Url }, "[DGHG] could not extract m3u8 (cfClearance="+cleared+", passMd5="+(!!passMd5Url)+")");
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
