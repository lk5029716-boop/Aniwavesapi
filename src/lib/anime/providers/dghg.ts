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
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime } from "../types.js";

// Python (urllib/OpenSSL, HTTP/1.1) passes Cloudflare's TLS fingerprint where
// Node's undici fetch and curl_cffi get 403 on /e/<id>/ajax. The DGHG HTTP
// extraction is done in dghg_http.py for that reason.
function dghgHttpScript(): string {
  if (process.env["DGHG_HTTP_SCRIPT"]) return process.env["DGHG_HTTP_SCRIPT"];
  // Candidate locations: project root (dev), dist (bundled), Render copy, cwd.
  // Bundle is ESM, so use import.meta.dirname (not __dirname).
  const dir = import.meta.dirname || process.cwd();
  const candidates = [
    join(dir, "dghg_http.py"),
    join(process.cwd(), "dghg_http.py"),
    "/opt/render/project/src/dghg_http.py",
    join(dir, "..", "..", "..", "dghg_http.py"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}
function pythonBin(): string {
  return process.env["DGHG_PYTHON"] || "python3";
}

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

/**
 * PRIMARY extraction — pure HTTP via Python (urllib/OpenSSL), no browser, no
 * Cloudflare JS challenge. Node's native fetch and curl_cffi get 403 on
 * /e/<id>/ajax (TLS fingerprint), but Python urllib passes — so we shell out
 * to dghg_http.py. This defeats the datacenter-IP block that kills the
 * Playwright path on Render.
 */
async function extractDghgHttp(embedUrl: string): Promise<{ m3u8: string | null; cfWall: boolean; reason?: string; detail?: any }> {
  try {
    const out = execFileSync(pythonBin(), [dghgHttpScript(), embedUrl], {
      timeout: 25000,
      encoding: "utf8",
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    const parsed = JSON.parse(out.trim().split("\n").pop() || "{}");
    if (parsed.ok && parsed.m3u8) {
      logger.info({ m3u8: String(parsed.m3u8).slice(0, 80) }, "[DGHG-http] OK");
      return { m3u8: parsed.m3u8, cfWall: false };
    }
    logger.warn({ reason: parsed.reason, status: parsed.status, len: parsed.len, title: parsed.title }, "[DGHG-http] no m3u8");
    return { m3u8: null, cfWall: parsed.reason === "cf-wall", reason: parsed.reason, detail: parsed };
  } catch (e: any) {
    logger.warn({ error: String(e?.message || e).slice(0, 160) }, "[DGHG-http] exec failed");
    return { m3u8: null, cfWall: false, reason: "exec-failed" };
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

  // 2) Fallback: Playwright. Only if explicitly enabled — it is blocked on
  //    datacenter IPs (Cloudflare managed challenge won't clear), so running it
  //    on Render just wastes ~60s before failing. Enable with DGHG_BROWSER_FALLBACK=1
  //    only on hosts/networks where the HTTP path is CF-walled but a residential
  //    IP can solve the challenge.
  if (!process.env["DGHG_BROWSER_FALLBACK"]) {
    const reason = http.reason || (http.cfWall ? "cf-wall" : "http-failed");
    const detail = http.detail ? ` | len=${http.detail.len} title=${http.detail.title} snippet=${(http.detail.snippet||"").slice(0,200)}` : "";
    logger.warn({ cfWall: http.cfWall, reason, detail }, "[DGHG] HTTP path failed; browser fallback disabled");
    throw new Error(`DGHG_HTTP_FAILED:${reason}${detail}`);
  }
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
