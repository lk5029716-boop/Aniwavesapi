/**
 * DGHG (DoodStream / PlayMogo / myvidplay) extractor.
 *
 * DGHG servers on aniwaves.ru are DoodStream embeds, currently fronted by
 * playmogo.com. The extraction chain:
 *
 * 1. Get embed URL from /ajax/sources → https://myvidplay.com/e/<key>
 * 2. Follow redirect to playmogo.com, extract page HTML
 * 3. Find /pass_md5/<hash>/<token> in the page JS
 * 4. GET /pass_md5/<hash>/<token> with Referer: https://playmogo.com/
 *    — uses curl_cffi (Chrome impersonation) to beat CF TLS fingerprinting
 * 5. Response is base CDN URL like:
 *    https://uio1105mk.cloudatacdn.com/<path>/olwliwe53y~<somechars>
 * 6. Final stream URL = base + <10 random chars> + "?token=" + token + "&expiry=" + Date.now()
 *
 * Our aniwaves_scraper.py handles steps 1-5 via curl_cffi (Chrome TLS
 * impersonation). This module calls that script as a subprocess, passing the
 * embed URL in and getting the final stream URL back as JSON.
 *
 * Fallback: If curl_cffi script is unavailable, falls back to Playwright
 * (Chromium/Playwright is already installed for the WNBF provider).
 */

import { execFileSync } from "child_process";
import { logger } from "../../logger.js";
import { extractViaPlaywright } from "./playwright-extractor.js";
import type { StreamSource, SkipTime } from "../types.js";

const ANIWAVES_SCRAPER = process.env["ANIWAVES_SCRAPER_PATH"] ?? ""

type DghgScriptResult =
  | { ok: true; m3u8: string; referer: string; expiry: number }
  | { ok: false; error: string };

function isPlayMogoHost(url: string): boolean {
  try {
    return new URL(url).hostname.includes("playmogo");
  } catch {
    return false;
  }
}

function isDghgEmbedUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.includes("myvidplay") || host.includes("playmogo");
  } catch {
    return false;
  }
}

export async function extractDghg(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  const playMogoUrl = isPlayMogoHost(embedUrl) ? embedUrl : null;
  const targetUrl = playMogoUrl ?? embedUrl;

  logger.info(
    { embedUrl: embedUrl.slice(0, 100), targetUrl: targetUrl.slice(0, 100) },
    "[DGHG] starting extraction"
  );

  // ── Primary: curl_cffi subprocess ─────────────────────────────────────────
  if (ANIWAVES_SCRAPER) {
    try {
      const result = execFileSync(
        "python3",
        [ANIWAVES_SCRAPER, "--server", targetUrl],
        {
          timeout: 30_000,
          encoding: "utf8",
          env: { ...process.env },
        }
      ).trim();

      const parsed = JSON.parse(result) as DghgScriptResult;

      if (parsed.ok) {
        logger.info(
          { m3u8: parsed.m3u8.slice(0, 100) },
          "[DGHG] curl_cffi extraction SUCCESS"
        );

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
      }

      logger.warn(
        { error: parsed.error },
        "[DGHG] curl_cffi extraction failed, falling back to Playwright"
      );
    } catch (err) {
      const e = err as Error & { stderr?: Buffer; status?: number };
      logger.warn(
        {
          error: e.message,
          stderr: e.stderr?.toString().slice(0, 200),
          status: e.status,
        },
        "[DGHG] curl_cffi subprocess failed, falling back to Playwright"
      );
    }
  }

  // ── Fallback: Playwright headless browser ──────────────────────────────────
  logger.info(
    { embedUrl: embedUrl.slice(0, 100) },
    "[DGHG] falling back to Playwright (Chromium)"
  );

  const pwResult = await extractViaPlaywright(embedUrl, "dghg", skipData);
  if (pwResult?.m3u8) {
    logger.info(
      { m3u8: pwResult.m3u8.slice(0, 100) },
      "[DGHG] Playwright extraction SUCCESS"
    );
    return pwResult;
  }

  logger.error(
    { embedUrl: embedUrl.slice(0, 100) },
    "[DGHG] all extraction methods failed"
  );
  return null;
}

export function isDghgServer(serverName: string): boolean {
  const n = serverName.toLowerCase();
  return n.includes("dghg") || n.includes("dood") || n.includes("playmogo");
}
