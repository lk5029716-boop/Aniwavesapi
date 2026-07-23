/**
 * DGHG (DoodStream / PlayMogo / myvidplay) extractor.
 *
 * HOW IT WORKS (primary path — no browser, no IP-block problem):
 *   The player page embeds the m3u8 token in plain HTML. The flow is:
 *     1. GET  https://<host>/e/<id>/ajax   (NOT behind Cloudflare's managed
 *        challenge — returns 200 with the player HTML, including the token)
 *     2. Regex the  /pass_md5/<hash>/<token>  URL out of that HTML
 *     3. GET  https://<host>/pass_md5/<hash>/<token>  -> body IS the CDN m3u8
 *   This is a normal HTTP request from the server. Cloudflare only challenges
 *   the pretty HTML document; the /e/<id>/ajax document and the /pass_md5/
 *   endpoint are reachable, so a datacenter IP (Render) works fine.
 *
 * FALLBACK (Playwright): only used if the HTTP path hits a Cloudflare wall
 * (e.g. host starts challenging /e/<id>/ajax). The browser solves the Turnstile
 * in-context and intercepts the /pass_md5/ XHR. NOTE: the browser path is
 * blocked on datacenter IPs (Cloudflare managed challenge won't clear) — it
 * only works from a residential IP. The HTTP path is the real fix.
 */

import { chromium, type Browser, type BrowserContext } from "playwright";
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime } from "../types.js";

const DGHG_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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

/** Extract the /pass_md5/<hash>/<token> URL from the player HTML. */
function extractPassMd5Url(html: string, origin: string): string | null {
  const m = html.match(/\/pass_md5\/[^\s"'\\]+/);
  if (!m) return null;
  return m[0].startsWith("http") ? m[0] : `${origin}${m[0]}`;
}

/**
 * PRIMARY extraction — pure HTTP, no browser, defeats the datacenter-IP block.
 * Returns the m3u8 URL or null (null does NOT mean failure: a CF wall on the
 * ajax doc means we should fall back to the browser path).
 */
async function extractDghgHttp(embedUrl: string): Promise<{ m3u8: string | null; cfWall: boolean }> {
  let host: string;
  let id: string;
  try {
    const u = new URL(embedUrl);
    host = u.hostname;
    const seg = u.pathname.split("/").filter(Boolean);
    id = seg[seg.length - 1] || "";
  } catch {
    return { m3u8: null, cfWall: false };
  }
  if (!id) return { m3u8: null, cfWall: false };

  const origin = `https://${host}`;
  const ajaxUrl = `${origin}/e/${id}/ajax`;
  try {
    const res = await fetch(ajaxUrl, {
      headers: { "User-Agent": DGHG_UA, Accept: "text/html,application/xhtml+xml", Referer: ajaxUrl },
      redirect: "follow",
    });
    const html = await res.text();
    if (/just a moment/i.test(html) || res.status === 403 || res.status === 503) {
      logger.warn({ status: res.status }, "[DGHG-http] Cloudflare wall on /e/<id>/ajax — will fall back to browser");
      return { m3u8: null, cfWall: true };
    }
    const pmUrl = extractPassMd5Url(html, origin);
    if (!pmUrl) {
      logger.warn("[DGHG-http] no /pass_md5/ token in ajax HTML");
      return { m3u8: null, cfWall: false };
    }
    const pmRes = await fetch(pmUrl, {
      headers: { "User-Agent": DGHG_UA, Accept: "*/*", Referer: ajaxUrl, "X-Requested-With": "XMLHttpRequest" },
    });
    const body = await pmRes.text();
    const m3u8 = extractM3u8Url(body);
    if (m3u8) logger.info({ m3u8: m3u8.slice(0, 80) }, "[DGHG-http] OK");
    return { m3u8, cfWall: false };
  } catch (e) {
    logger.warn({ error: String(e).slice(0, 160) }, "[DGHG-http] request failed");
    return { m3u8: null, cfWall: false };
  }
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

  // 1) Primary: pure-HTTP path (works on datacenter IPs — no Cloudflare wall).
  const http = await extractDghgHttp(embedUrl);
  if (http.m3u8) {
    let intro: SkipTime | null = null;
    let outro: SkipTime | null = null;
    if (skipData?.intro && (skipData.intro[0] !== 0 || skipData.intro[1] !== 0)) {
      intro = { start: skipData.intro[0], end: skipData.intro[1] };
    }
    if (skipData?.outro && (skipData.outro[0] !== 0 || skipData.outro[1] !== 0)) {
      outro = { start: skipData.outro[0], end: skipData.outro[1] };
    }
    return { type: "direct", provider: "dghg", m3u8: http.m3u8, subtitles: [], thumbnails: null, intro, outro };
  }

  // 2) Fallback: Playwright (only helps on residential IPs; kept for hosts that
  //    start challenging the ajax doc). Datacenter IPs will still fail here.
  logger.warn("[DGHG] HTTP path yielded nothing — falling back to Playwright browser");
  return extractDghgBrowser(embedUrl, skipData, _proxyUrl);
}

async function extractDghgBrowser(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] },
  _proxyUrl?: string | null
): Promise<StreamSource | null> {
  let browser: Browser | null = null;
  try {
    const proxyRaw =
      _proxyUrl || process.env["DGHG_PROXY_URL"] || process.env["HTTPS_PROXY"] || null;
    let launchProxy: { server: string; username?: string; password?: string } | undefined;
    if (proxyRaw) {
      try {
        const u = new URL(proxyRaw);
        launchProxy = {
          server: `${u.protocol || "http:"}//${u.hostname}${u.port ? ":" + u.port : ""}`,
        };
        if (u.username) launchProxy.username = decodeURIComponent(u.username);
        if (u.password) launchProxy.password = decodeURIComponent(u.password);
      } catch {
        launchProxy = { server: proxyRaw };
      }
      logger.info({ server: launchProxy.server }, "[DGHG-browser] using proxy");
    }

    browser = await chromium.launch({
      headless: true,
      proxy: launchProxy,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
        "--headless=new",
      ],
    });
    const ctx: BrowserContext = await browser.newContext({
      userAgent: DGHG_UA,
      viewport: { width: 1366, height: 768 },
      locale: "en-US",
      timezoneId: "America/New_York",
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      const navAny = navigator as any;
      if (!navAny.chrome) {
        Object.defineProperty(navigator, "chrome", { get: () => ({ runtime: {} }), configurable: true });
      }
    });

    let m3u8: string | null = null;
    let passMd5Url: string | null = null;
    page.on("response", (resp) => {
      if (/\/pass_md5\//i.test(resp.url())) passMd5Url = resp.url();
    });

    for (let attempt = 1; attempt <= 3 && !m3u8; attempt++) {
      try {
        await page.goto(embedUrl, { waitUntil: "commit", timeout: 25000 });
      } catch (navErr) {
        logger.warn({ error: String(navErr).slice(0, 100) }, "[DGHG-browser] goto error, retrying");
      }
      try {
        await page.waitForFunction(
          () => document.title && !/just a moment/i.test(document.title),
          { timeout: 20000 },
        );
      } catch {
        logger.warn({ title: await page.title().catch(() => "") }, "[DGHG-browser] CF wall still up");
      }
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
          logger.warn({ error: String(e).slice(0, 120) }, "[DGHG-browser] pass_md5 body read failed");
        }
      }
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
      logger.info({ attempt, passMd5: !!passMd5Url, m3u8: !!m3u8 }, "[DGHG-browser] load attempt");
    }

    if (!m3u8) {
      const finalUrl = page.url();
      let title = "";
      let snippet = "";
      try {
        title = await page.title();
        snippet = (await page.content()).slice(0, 400);
      } catch { /* ignore */ }
      logger.warn({ passMd5: !!passMd5Url, finalUrl, title }, "[DGHG-browser] could not extract m3u8");
      return {
        type: "direct",
        provider: "dghg",
        m3u8: null as unknown as string,
        subtitles: [],
        thumbnails: null,
        intro: null,
        outro: null,
        _diag: {
          path: "browser",
          cfWallUp: /just a moment/i.test(title),
          proxyUsed: !!launchProxy,
          passMd5Seen: !!passMd5Url,
          finalUrl,
          title,
          pageSnippet: snippet,
        },
      } as any;
    }

    logger.info({ m3u8: m3u8.slice(0, 80) }, "[DGHG-browser] OK");
    let intro: SkipTime | null = null;
    let outro: SkipTime | null = null;
    if (skipData?.intro && (skipData.intro[0] !== 0 || skipData.intro[1] !== 0)) {
      intro = { start: skipData.intro[0], end: skipData.intro[1] };
    }
    if (skipData?.outro && (skipData.outro[0] !== 0 || skipData.outro[1] !== 0)) {
      outro = { start: skipData.outro[0], end: skipData.outro[1] };
    }
    return { type: "direct", provider: "dghg", m3u8, subtitles: [], thumbnails: null, intro, outro };
  } catch (e) {
    logger.warn({ error: String(e).slice(0, 200) }, "[DGHG-browser] exception, skipping");
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}
