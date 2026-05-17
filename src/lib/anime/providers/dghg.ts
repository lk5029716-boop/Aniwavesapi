/**
 * DGHG / PlayMogo / DoodStream provider extractor.
 *
 * Simple HTTP extraction — no Playwright needed.
 *
 * Flow:
 *   1. GET /e/{videoCode} → extract pass_md5 path and token from HTML
 *   2. GET /pass_md5/{path} → get CDN base URL (plain text response)
 *   3. Build final URL: {cdnUrl}?token={token}&expiry={timestamp}
 *
 * Uses curl because Cloudflare blocks axios/node-fetch TLS fingerprints.
 * Falls back to axios if curl is not available.
 */
import { execSync, execFileSync } from "child_process";
import axios from "axios";
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime } from "../types.js";

const DOOD_HOSTS = [
  "playmogo.com", "myvidplay.com", "doodstream.com", "dood.la",
  "dood.to", "dood.so", "dood.ws", "dood.pm", "dood.wf", "dood.re",
  "dood.yt", "dood.cx", "dood.sh", "dood.watch",
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let curlAvailable: boolean | null = null;

function isCurlAvailable(): boolean {
  if (curlAvailable !== null) return curlAvailable;
  try {
    execSync("which curl", { encoding: "utf8", timeout: 5000 });
    curlAvailable = true;
  } catch {
    curlAvailable = false;
  }
  return curlAvailable;
}

function isPlaymogoHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return DOOD_HOSTS.some((h) => host.includes(h));
  } catch {
    return false;
  }
}

function curlFetch(url: string, referer: string): string {
  try {
    const result = execFileSync("curl", [
      "-s", "-L",
      "-A", UA,
      "-H", "Accept: text/html,*/*",
      "-H", `Referer: ${referer}`,
      "--max-redirs", "5",
      "--connect-timeout", "15",
      "--max-time", "30",
      "-w", "\n%{http_code}",
      url,
    ], { encoding: "utf8", timeout: 35000 });

    const lines = result.trim().split("\n");
    const httpCode = lines[lines.length - 1];
    const body = lines.slice(0, -1).join("\n");

    if (httpCode !== "200") {
      logger.warn({ url: url.slice(0, 80), httpCode }, "curl non-200 response");
      return "";
    }
    return body;
  } catch (err) {
    const e = err as Error;
    logger.warn({ url: url.slice(0, 80), error: e.message }, "curl fetch failed");
    return "";
  }
}

async function axiosFetch(url: string, referer: string): Promise<string> {
  const resp = await axios.get(url, {
    timeout: 15000,
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: referer,
    },
    maxRedirects: 5,
  });
  return resp.data as string;
}

function fetchPage(url: string, referer: string): string {
  if (isCurlAvailable()) {
    return curlFetch(url, referer);
  }
  // Fallback: use axios (may get 403 on some hosts)
  logger.warn("curl not available, falling back to axios (may get 403)");
  return "";
}

export async function extractDghg(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  logger.info({ embedUrl: embedUrl.slice(0, 100), curl: isCurlAvailable() }, "[DGHG] starting extraction");

  // Step 1: Fetch embed page
  let html: string;
  if (isCurlAvailable()) {
    html = curlFetch(embedUrl, "https://aniwaves.ru/");
  } else {
    html = await axiosFetch(embedUrl, "https://aniwaves.ru/");
  }

  if (!html) {
    logger.error("[DGHG] Step 1 FAILED — empty response");
    return null;
  }

  // Step 2: Extract pass_md5 path from HTML
  // Pattern: $.get('/pass_md5/{file_id}-{nums}-{nums}-{nums}-{hash}/{token}', function(data)
  let passMd5Path: string | null = null;
  const passMd5Match = html.match(/\$\.get\s*\(\s*['"]\/pass_md5\/([^'"]+)['"]\s*,/);
  if (passMd5Match) {
    passMd5Path = passMd5Match[1];
  }

  // Extract token from pass_md5 path (last /-separated segment)
  let token: string | null = null;
  if (passMd5Path) {
    const parts = passMd5Path.split("/");
    token = parts[parts.length - 1] || null;
  }

  // Fallback: extract token from cookieIndex='{token}'
  if (!token) {
    const tokenMatch = html.match(/cookieIndex\s*=\s*['"]([^'"]+)['"]/);
    token = tokenMatch?.[1] ?? null;
  }

  logger.debug({ passMd5Path: passMd5Path?.slice(0, 100), token }, "[DGHG] extracted creds");

  if (!passMd5Path || !token) {
    logger.error({ hasPassMd5: !!passMd5Path, hasToken: !!token }, "[DGHG] Step 2 FAILED");
    return null;
  }

  // Step 3: Call pass_md5 to get CDN URL
  const urlObj = new URL(embedUrl);
  const passMd5Url = `https://${urlObj.hostname}/pass_md5/${passMd5Path}`;

  let cdnBaseUrl: string;
  if (isCurlAvailable()) {
    cdnBaseUrl = curlFetch(passMd5Url, embedUrl);
  } else {
    cdnBaseUrl = await axiosFetch(passMd5Url, embedUrl);
  }

  if (!cdnBaseUrl || !cdnBaseUrl.startsWith("http")) {
    logger.error({ cdnBase: cdnBaseUrl?.slice(0, 100) }, "[DGHG] Step 3 FAILED");
    return null;
  }

  // Step 4: Build final video URL
  const expiry = Date.now();
  const finalUrl = `${cdnBaseUrl}?token=${token}&expiry=${expiry}`;

  logger.info({ finalUrl: finalUrl.slice(0, 120) }, "[DGHG] extraction SUCCESS");

  let intro: SkipTime | null = null;
  let outro: SkipTime | null = null;
  if (skipData?.intro?.[1] && skipData.intro[1] > 0) {
    intro = { start: skipData.intro[0], end: skipData.intro[1] };
  }
  if (skipData?.outro?.[1] && skipData.outro[1] > 0) {
    outro = { start: skipData.outro[0], end: skipData.outro[1] };
  }

  return {
    type: "direct",
    provider: "dghg",
    m3u8: finalUrl,
    subtitles: [],
    thumbnails: null,
    intro,
    outro,
  };
}

export { isPlaymogoHost };
