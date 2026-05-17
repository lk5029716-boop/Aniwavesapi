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
import { execFileSync } from "child_process";
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

function isPlaymogoHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return DOOD_HOSTS.some((h) => host.includes(h));
  } catch {
    return false;
  }
}

function curlFetch(url: string, referer: string): { body: string; error: string | null } {
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
      return { body: body.slice(0, 300), error: `HTTP ${httpCode}` };
    }
    return { body, error: null };
  } catch (err) {
    const e = err as Error;
    return { body: "", error: e.message };
  }
}

async function axiosFetch(url: string, referer: string): Promise<{ body: string; error: string | null }> {
  try {
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
    return { body: resp.data as string, error: null };
  } catch (err) {
    const e = err as Error & { response?: { status: number } };
    return { body: "", error: `HTTP ${e.response?.status || 'unknown'}: ${e.message}` };
  }
}

export async function extractDghg(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  logger.info({ embedUrl: embedUrl.slice(0, 100) }, "[DGHG] starting extraction");

  // Step 1: Fetch embed page — always try curl first
  let html: string;
  let fetchError: string | null = null;

  const step1 = curlFetch(embedUrl, "https://aniwaves.ru/");
  if (step1.error || !step1.body) {
    // curl failed, try axios as fallback
    logger.warn({ error: step1.error }, "[DGHG] curl failed, trying axios");
    const step1Axios = await axiosFetch(embedUrl, "https://aniwaves.ru/");
    html = step1Axios.body;
    fetchError = step1Axios.error;
  } else {
    html = step1.body;
    fetchError = step1.error;
  }

  if (!html || fetchError) {
    logger.error({ error: fetchError }, "[DGHG] Step 1 FAILED");
    return null;
  }

  // Step 2: Extract pass_md5 path
  let passMd5Path: string | null = null;
  const passMd5Match = html.match(/\$\.get\s*\(\s*['"]\/pass_md5\/([^'"]+)['"]\s*,/);
  if (passMd5Match) passMd5Path = passMd5Match[1];

  let token: string | null = null;
  if (passMd5Path) {
    const parts = passMd5Path.split("/");
    token = parts[parts.length - 1] || null;
  }
  if (!token) {
    const tokenMatch = html.match(/cookieIndex\s*=\s*['"]([^'"]+)['"]/);
    token = tokenMatch?.[1] ?? null;
  }

  logger.debug({ passMd5Path: passMd5Path?.slice(0, 100), token }, "[DGHG] extracted creds");

  if (!passMd5Path || !token) {
    logger.error({ hasPassMd5: !!passMd5Path, hasToken: !!token }, "[DGHG] Step 2 FAILED");
    return null;
  }

  // Step 3: Call pass_md5
  const urlObj = new URL(embedUrl);
  const passMd5Url = `https://${urlObj.hostname}/pass_md5/${passMd5Path}`;

  let cdnBaseUrl: string;
  const step3 = curlFetch(passMd5Url, embedUrl);
  if (step3.error || !step3.body || !step3.body.startsWith("http")) {
    logger.warn({ error: step3.error }, "[DGHG] curl pass_md5 failed, trying axios");
    const step3Axios = await axiosFetch(passMd5Url, embedUrl);
    cdnBaseUrl = step3Axios.body;
    if (step3Axios.error || !cdnBaseUrl.startsWith("http")) {
      logger.error({ error: step3Axios.error, cdnBase: cdnBaseUrl?.slice(0, 50) }, "[DGHG] Step 3 FAILED");
      return null;
    }
  } else {
    cdnBaseUrl = step3.body;
  }

  // Step 4: Build final URL
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
