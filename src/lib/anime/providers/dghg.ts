/**
 * DGHG (DoodStream / PlayMogo / myvidplay) extractor.
 *
 * NOTE: DGHG requires TLS fingerprint impersonation (Chrome JA3/JA4)
 * to bypass Cloudflare on playmogo.com. This only works with curl_cffi
 * from a non-cloud IP. Render free tier blocks both conditions:
 *   - No Python/curl_cffi in the Node.js runtime image
 *   - playmogo.com blocks Render datacenter IPs
 *
 * This extractor will return null immediately so the fallback chain
 * continues to the next provider. DGHG only works with a proxy or
 * from a residential IP with curl_cffi installed.
 *
 * To enable: set ANIWAVES_SCRAPER_PATH env var on a deployment that
 * has Python + curl_cffi and a non-blocked IP.
 */

import { execFileSync } from "child_process";
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime } from "../types.js";

const ANIWAVES_SCRAPER = process.env["ANIWAVES_SCRAPER_PATH"] ?? "";

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

export async function extractDghg(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  logger.info({ embedUrl: embedUrl.slice(0, 100) }, "[DGHG] start");

  if (!ANIWAVES_SCRAPER) {
    logger.info("[DGHG] ANIWAVES_SCRAPER_PATH not set, skipping");
    return null;
  }

  try {
    const result = execFileSync(
      "python3",
      [ANIWAVES_SCRAPER, "--server", embedUrl],
      { timeout: 12_000, encoding: "utf8", env: { ...process.env } }
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
      { error: e.message.slice(0, 120), stderr: e.stderr?.toString().slice(0, 100) },
      "[DGHG] error, skipping"
    );
    return null;
  }
}

export function isDghgServer(serverName: string): boolean {
  const n = serverName.toLowerCase();
  return n.includes("dghg") || n.includes("dood") || n.includes("playmogo");
}
