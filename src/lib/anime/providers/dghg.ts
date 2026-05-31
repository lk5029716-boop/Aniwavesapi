/**
 * DGHG (DoodStream / PlayMogo / myvidplay) extractor.
 *
 * Extraction chain:
 * 1. embed URL from aniwaves → https://myvidplay.com/e/<key>
 * 2. curl_cffi (Chrome TLS impersonation) fetches the myvidplay/playmogo page
 * 3. Passes through /pass_md5 flow to get the base CDN URL
 * 4. Returns m3u8 URL
 *
 * Requires: ANIWAVES_SCRAPER_PATH env var pointing to aniwaves_scraper.py
 * The Python script uses curl_cffi to bypass Cloudflare TLS fingerprint checks.
 */

import { execFileSync } from "child_process";
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime } from "../types.js";

const ANIWAVES_SCRAPER = process.env["ANIWAVES_SCRAPER_PATH"] ?? "";

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

export function isDghgEmbedUrl(url: string): boolean {
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
  const targetUrl = isPlayMogoHost(embedUrl) ? embedUrl : embedUrl;

  logger.info(
    { embedUrl: embedUrl.slice(0, 100) },
    "[DGHG] starting extraction"
  );

  if (!ANIWAVES_SCRAPER) {
    logger.warn("[DGHG] ANIWAVES_SCRAPER_PATH not set, skipping");
    return null;
  }

  try {
    const result = execFileSync(
      "python3",
      [ANIWAVES_SCRAPER, "--server", targetUrl],
      {
        timeout: 20_000,
        encoding: "utf8",
        env: { ...process.env },
      }
    ).trim();

    const parsed = JSON.parse(result) as DghgScriptResult;

    if (!parsed.ok) {
      logger.warn({ error: parsed.error }, "[DGHG] extraction failed");
      return null;
    }

    logger.info(
      { m3u8: parsed.m3u8.slice(0, 100) },
      "[DGHG] extraction SUCCESS"
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
  } catch (err) {
    const e = err as Error & { stderr?: Buffer; status?: number };
    logger.warn(
      {
        error: e.message,
        stderr: e.stderr?.toString().slice(0, 200),
        status: e.status,
      },
      "[DGHG] extraction error"
    );
    return null;
  }
}

export function isDghgServer(serverName: string): boolean {
  const n = serverName.toLowerCase();
  return n.includes("dghg") || n.includes("dood") || n.includes("playmogo");
}
