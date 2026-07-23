/**
 * DGHG (DoodStream / PlayMogo / myvidplay) extractor.
 *
 * Uses curl_cffi (Chrome TLS impersonation) via Python subprocess to bypass
 * Cloudflare JA3/JA4 checks on playmogo.com / myvidplay.com.
 *
 * Extraction chain:
 *   1. Fetch embed page with curl_cffi (Chrome impersonation)
 *   2. Extract /pass_md5/<hash>/<token> from page HTML
 *   3. Call /pass_md5/<hash>/<token> → get base CDN URL
 *   4. Return base + /index-f1-v1-a1.m3u8
 */

import { execFileSync } from "child_process";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime } from "../types.js";

type DghgScriptResult =
  | { ok: true; m3u8: string; referer: string; expiry: number }
  | { ok: false; error: string };

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

export async function extractDghg(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] },
  proxyUrl?: string | null
): Promise<StreamSource | null> {
  logger.info({ embedUrl: embedUrl.slice(0, 100) }, "[DGHG] start");

  // PlayMogo / myvidplay sit behind an ACTIVE Cloudflare challenge ("Just a
  // moment..."). curl_cffi TLS-impersonation is NOT enough -- CF serves the
  // interstitial instead of the page containing /pass_md5/. We solve the
  // challenge in a real headless browser, steal the cf_clearance cookie + UA,
  // and feed them to the Python scraper so its request clears CF.
  const cf = await solveCloudflare(embedUrl).catch((e) => {
    logger.warn({ error: String(e).slice(0, 120) }, "[DGHG] CF solve failed, continuing without");
    return null;
  });

  // Try multiple possible scraper paths (Render env var, Docker default, relative)
  const envPath = process.env["ANIWAVES_SCRAPER_PATH"];
  const candidatePaths = [
    envPath,
    "/app/aniwaves_scraper.py",
    "/opt/render/project/src/aniwaves_scraper.py",
    "aniwaves_scraper.py",
  ].filter(Boolean) as string[];

  let scraperPath = candidatePaths[0] ?? "/app/aniwaves_scraper.py";
  for (const p of candidatePaths) {
    try {
      execFileSync("test", ["-f", p], { timeout: 3000 });
      scraperPath = p;
      logger.info({ scraperPath }, "[DGHG] found scraper at");
      break;
    } catch {
      continue;
    }
  }

  try {
    const env = { ...process.env };
    if (proxyUrl) {
      env["ANIWAVES_PROXY_URL"] = proxyUrl;
      logger.info({ proxyUrl: proxyUrl.slice(0, 60) }, "[DGHG] using proxy");
    }
    if (cf) {
      env["DGHG_CF_COOKIES"] = JSON.stringify(cf.cookies);
      env["DGHG_CF_UA"] = cf.userAgent;
      logger.info({ n: cf.cookies.length }, "[DGHG] passing CF clearance to scraper");
    }
    // CF was solved on the post-redirect host (myvidplay -> playmogo), so the
    // clearance cookie is scoped to that domain. Pass the FINAL url the browser
    // landed on to the scraper, otherwise it re-requests myvidplay and 403s again.
    const scrapeUrl = cf?.finalUrl || embedUrl;
    logger.info({ scrapeUrl: scrapeUrl.slice(0, 90) }, "[DGHG] scraping resolved url");
    const result = execFileSync(
      "python3",
      [scraperPath, "--server", scrapeUrl],
      { timeout: 15_000, encoding: "utf8", env }
    ).trim();

    const parsed = JSON.parse(result) as DghgScriptResult;

    if (!parsed.ok) {
      logger.warn({ error: parsed.error }, "[DGHG] failed");
      return null;
    }

    logger.info({ m3u8: parsed.m3u8.slice(0, 80) }, "[DGHG] OK");

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
      m3u8: parsed.m3u8,
      subtitles: [],
      thumbnails: null,
      intro,
      outro,
    };
  } catch (err) {
    const e = err as Error & { stderr?: Buffer; status?: number };
    logger.warn(
      { error: e.message.slice(0, 120), stderr: e.stderr?.toString().slice(0, 200) },
      "[DGHG] error, skipping"
    );
    return null;
  }
}

/**
 * Solve Cloudflare's managed challenge for a PlayMogo / myvidplay embed URL.
 * Returns the cookies (incl. cf_clearance) + the browser UA. Returns null if we
 * couldn't clear CF within the timeout (caller falls back gracefully).
 *
 * NOTE: requires the chromium binary (`playwright install chromium`). On
 * Render/Docker the browser is already provisioned by the existing Playwright
 * usage in this repo (test_dghg.cjs, playwright-extractor.ts).
 */
async function solveCloudflare(embedUrl: string): Promise<{ cookies: { name: string; value: string; domain?: string }[]; userAgent: string; finalUrl?: string } | null> {
  const host = (() => { try { return new URL(embedUrl).hostname; } catch { return ""; } })();
  if (!host.includes("myvidplay") && !host.includes("playmogo")) return null;

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process", "--no-zygote"],
    });
    const ctx: BrowserContext = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });
    const page = await ctx.newPage();
    page.on("console", (mm) => logger.debug({ cfConsole: mm.text().slice(0, 120) }, "[DGHG] CF page console"));
    let finalUrl = embedUrl;
    try {
      const resp = await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      finalUrl = page.url();
      logger.info({ status: resp?.status(), finalUrl }, "[DGHG] CF page loaded");
    } catch (navErr) {
      logger.warn({ error: String(navErr).slice(0, 120) }, "[DGHG] CF goto error (continuing to wait for cookie)");
    }

    // Wait until Cloudflare drops the challenge: cf_clearance cookie appears
    // and the page is no longer the "Just a moment..." interstitial.
    const deadline = Date.now() + 45_000;
    let cleared = false;
    while (Date.now() < deadline) {
      const cookies = await ctx.cookies();
      cleared = cookies.some((c) => c.name === "cf_clearance");
      const body = (await page.content().catch(() => "")) || "";
      const stillChallenge = /just a moment|checking your browser|challenge-platform/i.test(body);
      if (cleared && !stillChallenge) break;
      await page.waitForTimeout(1500);
    }

    const cookies = (await ctx.cookies()).map((c) => ({ name: c.name, value: c.value, domain: c.domain }));
    const userAgent = (await page.evaluate(() => navigator.userAgent).catch(() => "")) as string;
    const ok = cookies.some((c) => c.name === "cf_clearance");
    logger.info({ cfClearance: ok, cookieCount: cookies.length, userAgent: userAgent.slice(0, 40) }, "[DGHG] CF solve done");
    return ok ? { cookies, userAgent, finalUrl } : null;
  } catch (e) {
    logger.warn({ error: String(e).slice(0, 200) }, "[DGHG] CF solve exception");
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}
