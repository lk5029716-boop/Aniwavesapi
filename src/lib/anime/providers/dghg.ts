/**
 * DGHG / PlayMogo / DoodStream provider extractor.
 *
 * Flow:
 *   1. GET /e/{videoCode} → extract pass_md5 path and token from HTML
 *   2. GET /pass_md5/{path} → get CDN base URL
 *   3. Build final URL: {cdnUrl}?token={token}&expiry={timestamp}
 *
 * Uses curl because Cloudflare blocks axios/node-fetch TLS fingerprints.
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

function tryCurl(url: string, referer: string): { body: string; error: string | null } {
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
      return { body: body.slice(0, 200), error: `HTTP ${httpCode}` };
    }
    return { body, error: null };
  } catch (err) {
    return { body: "", error: (err as Error).message };
  }
}

async function tryAxios(url: string, referer: string): Promise<{ body: string; error: string | null }> {
  try {
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,*/*",
        Referer: referer,
      },
      maxRedirects: 5,
    });
    return { body: resp.data as string, error: null };
  } catch (err) {
    const e = err as Error & { response?: { status: number } };
    return { body: "", error: `HTTP ${e.response?.status || '?'}: ${e.message}` };
  }
}

export async function extractDghg(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource & { _dghgDebug?: string }> {
  const debug: string[] = [];
  debug.push(`embedUrl=${embedUrl}`);

  // Step 1: Fetch embed page
  const step1 = tryCurl(embedUrl, "https://aniwaves.ru/");
  debug.push(`curl: error=${step1.error || 'none'}, bodyLen=${step1.body.length}`);

  if (step1.error || !step1.body) {
    // Try axios fallback
    const step1a = await tryAxios(embedUrl, "https://aniwaves.ru/");
    debug.push(`axios: error=${step1a.error || 'none'}, bodyLen=${step1a.body.length}`);
    if (step1a.error || !step1a.body) {
      logger.error({ debug: debug.join("; ") }, "[DGHG] Step 1 FAILED");
      return { type: "direct", provider: "dghg", m3u8: null, subtitles: [], thumbnails: null, intro: null, outro: null, _dghgDebug: debug.join("; ") };
    }
  }

  const html = step1.body || "";

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

  debug.push(`passMd5=${!!passMd5Path}, token=${token?.slice(0, 10) || 'none'}`);

  if (!passMd5Path || !token) {
    logger.error({ debug: debug.join("; ") }, "[DGHG] Step 2 FAILED");
    return { type: "direct", provider: "dghg", m3u8: null, subtitles: [], thumbnails: null, intro: null, outro: null, _dghgDebug: debug.join("; ") };
  }

  // Step 3: Call pass_md5
  const urlObj = new URL(embedUrl);
  const passMd5Url = `https://${urlObj.hostname}/pass_md5/${passMd5Path}`;

  const step3 = tryCurl(passMd5Url, embedUrl);
  debug.push(`pass_md5 curl: error=${step3.error || 'none'}, body=${step3.body.slice(0, 80)}`);

  if (step3.error || !step3.body || !step3.body.startsWith("http")) {
    const step3a = await tryAxios(passMd5Url, embedUrl);
    debug.push(`pass_md5 axios: error=${step3a.error || 'none'}, body=${step3a.body.slice(0, 80)}`);
    if (step3a.error || !step3a.body || !step3a.body.startsWith("http")) {
      logger.error({ debug: debug.join("; ") }, "[DGHG] Step 3 FAILED");
      return { type: "direct", provider: "dghg", m3u8: null, subtitles: [], thumbnails: null, intro: null, outro: null, _dghgDebug: debug.join("; ") };
    }
  }

  const cdnBaseUrl = (step3.body || "").startsWith("http") ? step3.body : "";
  if (!cdnBaseUrl) {
    logger.error({ debug: debug.join("; ") }, "[DGHG] Step 3 FAILED - no CDN");
    return { type: "direct", provider: "dghg", m3u8: null, subtitles: [], thumbnails: null, intro: null, outro: null, _dghgDebug: debug.join("; ") };
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
