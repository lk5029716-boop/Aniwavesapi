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
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  logger.info({ embedUrl: embedUrl.slice(0, 100) }, "[DGHG] start");

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
    const result = execFileSync(
      "python3",
      [scraperPath, "--server", embedUrl],
      { timeout: 15_000, encoding: "utf8", env: { ...process.env } }
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
